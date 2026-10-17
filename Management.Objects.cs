using System.IO;
using System.Text.Json.Nodes;

namespace Watcher;

public sealed record FileEntry(string Name, string Type);

/// <summary>Changes to existing objects, file transfers and backups. Each one needs <c>confirmed: true</c> from the page.</summary>
public sealed partial class Management
{
    public const int MaxFileEntries = 2000;
    public const int MaxFileText = 64 * 1024;
    private static readonly string[] BuiltinNetworks = ["bridge", "host", "none"];

    /// <summary>Removes one selected object without --force; in-use images and networks are refused before wslc runs.</summary>
    private async Task<object> RemoveAsync(Parameters p, CancellationToken token)
    {
        var kind = p.Kind();
        var name = p.Identifier("name");
        p.Confirm($"Removing {kind} '{name}'");
        switch (kind)
        {
            case "network":
                if (BuiltinNetworks.Contains(name)) throw new InvalidOperationException($"'{name}' is a built-in network and cannot be removed.");
                var network = await InspectAsync("network", name, token);
                if (network["Containers"] is JsonObject { Count: > 0 } attached)
                {
                    var members = attached.Select(pair => pair.Value?["Name"]?.ToString() ?? pair.Key);
                    throw new InvalidOperationException($"Network '{name}' is in use by {string.Join(", ", members)}.");
                }
                await ChangeAsync($"Removing network '{name}'", ["network", "remove", name], token);
                break;
            case "image":
                await RequireUnusedImageAsync(name, token);
                // --no-prune keeps untagged parents, so only the selected image goes.
                await ChangeAsync($"Removing image '{name}'", ["image", "remove", "--no-prune", name], token);
                break;
            default:
                await InspectAsync("volume", name, token);
                // wslc itself refuses to remove a volume a container uses.
                await ChangeAsync($"Removing volume '{name}'", ["volume", "remove", name], token);
                break;
        }
        return new { message = $"Removed {kind} '{name}'." };
    }

    /// <summary>The image listing counts containers per image; anything but a confirmed zero is treated as in use.</summary>
    private async Task RequireUnusedImageAsync(string name, CancellationToken token)
    {
        var image = await InspectAsync("image", name, token);
        var id = (image["Id"]?.ToString() ?? "").Replace("sha256:", "");
        var listing = await RunAsync("Listing images", ["image", "list", "--format", "json"], token);
        var row = Inspection.Objects(listing.Output)
            .FirstOrDefault(r => r["ID"]?.ToString() is { Length: > 0 } shortId && id.StartsWith(shortId.Replace("sha256:", ""), StringComparison.OrdinalIgnoreCase));
        var containers = row?["Containers"]?.ToString();
        if (containers != "0")
        {
            throw new InvalidOperationException(row is null
                ? $"Could not confirm that image '{name}' is unused, so it was not removed."
                : $"Image '{name}' is used by {containers} container(s); remove those containers first.");
        }
    }

    private async Task<object> ConnectAsync(Parameters p, CancellationToken token)
    {
        var network = p.Identifier("network");
        var name = p.Identifier("name");
        var disconnect = p.Flag("disconnect");
        p.Confirm(disconnect ? $"Disconnecting '{name}' from '{network}'" : $"Connecting '{name}' to '{network}'");
        var verb = disconnect ? "disconnect" : "connect";
        await ChangeAsync($"Network {verb}", ["network", verb, network, name], token);
        return new { message = disconnect ? $"Disconnected '{name}' from network '{network}'." : $"Connected '{name}' to network '{network}'." };
    }

    private async Task<object> CopyAsync(Parameters p, CancellationToken token)
    {
        var name = ContainerName(p);
        var containerPath = p.ContainerPath("containerPath");
        var hostPath = p.HostPath("hostPath");
        var direction = p.Required("direction");
        string source, target;
        if (direction == "out")
        {
            RequireHostTarget(hostPath, p.Flag("overwrite"));
            (source, target) = ($"{name}:{containerPath}", hostPath);
            if (p.Flag("directory") && !Path.EndsInDirectorySeparator(target)) target += Path.DirectorySeparatorChar;
        }
        else if (direction == "in")
        {
            if (!File.Exists(hostPath) && !Directory.Exists(hostPath)) throw new ArgumentException($"'{hostPath}' does not exist.");
            (source, target) = (hostPath, $"{name}:{containerPath}");
        }
        else
        {
            throw new ArgumentException("direction must be out or in.");
        }
        p.Confirm($"Copying {source} to {target}");
        await ChangeAsync($"Copying {source} to {target}", ["container", "cp", "--quiet", source, target], token, Transfer, target);
        return new { message = $"Copied {source} to {target}." };
    }

    private async Task<object> SaveImageAsync(Parameters p, CancellationToken token)
    {
        var name = p.Identifier("name");
        var path = p.HostPath("path");
        RequireHostTarget(path, p.Flag("overwrite"));
        p.Confirm($"Saving image '{name}' to {path}");
        await ChangeAsync($"Saving image '{name}'", ["image", "save", "--output", path, name], token, Transfer, path);
        return new { message = $"Saved image '{name}' to {path}." };
    }

    /// <summary>
    /// Copies a volume out through an existing, stopped container that mounts it, so no helper container is created and
    /// no live database files are read mid-write.
    /// </summary>
    private async Task<object> BackupVolumeAsync(Parameters p, CancellationToken token)
    {
        var volumeName = p.Identifier("name");
        var path = p.HostPath("path");
        var container = ContainerName(p, "container");
        var requested = p.ContainerPath("containerPath", "/").TrimEnd('/');
        RequireHostTarget(path, p.Flag("overwrite"));
        p.Confirm($"Backing up volume '{volumeName}' to {path}");

        var volume = (await InspectAsync("volume", volumeName, token))["Name"]?.ToString() ?? volumeName;
        var inspect = await InspectAsync("container", container, token);
        var state = inspect["State"] as JsonObject;
        if (state?["Running"]?.GetValue<bool>() != false || state["Status"]?.ToString() is "running" or "paused" or "restarting")
        {
            throw new InvalidOperationException($"Stop '{container}' before backing up '{volumeName}'; copying files a running service writes can produce a broken backup.");
        }
        var mount = (inspect["Mounts"] as JsonArray ?? []).OfType<JsonObject>()
            .FirstOrDefault(m => m["Type"]?.ToString() == "volume" && m["Name"]?.ToString() == volume
                && (requested.Length == 0 || m["Destination"]?.ToString()?.TrimEnd('/') == requested))
            ?? throw new InvalidOperationException(requested.Length == 0
                ? $"'{container}' does not mount volume '{volumeName}'."
                : $"'{container}' does not mount volume '{volumeName}' at {requested}.");
        var source = $"{container}:{mount["Destination"]}";
        await RequireStoppedWritersAsync(volume, container, token);
        var destination = Path.EndsInDirectorySeparator(path) ? path : path + Path.DirectorySeparatorChar;
        await ChangeAsync($"Backing up volume '{volumeName}'", ["container", "cp", "--quiet", source, destination], token, Transfer, path);
        return new { message = $"Copied volume '{volumeName}' (mounted at {mount["Destination"]} in stopped container '{container}') to {path}." };
    }

    private async Task RequireStoppedWritersAsync(string volume, string selected, CancellationToken token)
    {
        var result = await RunAsync("Checking containers that may write the volume", ["container", "list", "--all", "--format", "json"], token);
        foreach (var row in Inspection.Objects(result.Output))
        {
            var name = row["Names"]?.ToString().TrimStart('/') ?? "";
            var status = row["State"]?.ToString();
            if (name == selected || status is "created" or "exited" or "dead") continue;
            if (name.Length == 0) throw new InvalidOperationException("A container's identity could not be verified, so the volume was not copied.");
            var other = await InspectAsync("container", name, token);
            var state = other["State"] as JsonObject;
            if (state?["Running"]?.GetValue<bool>() == false && state["Status"]?.ToString() is "created" or "exited" or "dead") continue;
            var writesVolume = (other["Mounts"] as JsonArray ?? []).OfType<JsonObject>().Any(m =>
                m["Type"]?.ToString() == "volume" && m["Name"]?.ToString() == volume
                && m["ReadWrite"]?.GetValue<bool>() != false && m["RW"]?.GetValue<bool>() != false);
            if (writesVolume) throw new InvalidOperationException($"Stop '{name}' before backing up '{volume}'; it also writes this volume.");
        }
    }

    private static string ContainerName(Parameters p, string key = "name") =>
        p.Identifier(key) is var name && name.Contains(':') ? throw new ArgumentException($"Invalid {key} '{name}'.") : name;

    private static void RequireHostTarget(string path, bool overwrite)
    {
        if (!overwrite && (File.Exists(path) || Directory.Exists(path)))
        {
            throw new InvalidOperationException($"'{path}' already exists. Confirm overwriting it or choose another location.");
        }
        if (!Directory.Exists(path) && (Path.GetDirectoryName(path) is not { } folder || !Directory.Exists(folder)))
        {
            throw new ArgumentException($"The folder for '{path}' does not exist.");
        }
    }

    /// <summary>
    /// Lists a directory or previews a file. The path reaches the shell as a positional argument, never inside the script.
    /// Output: "D\n" then "type\tname\0" per entry, or "F\n" then the first bytes of the file.
    /// </summary>
    public static readonly string FilesScript = """
        p=$1
        if [ -d "$p" ]; then
          cd -- "$p" || exit 3
          printf 'D\n'
          for f in * .[!.]* ..?*; do
            if [ -L "$f" ]; then t=link
            elif [ -d "$f" ]; then t=dir
            elif [ -f "$f" ]; then t=file
            elif [ -e "$f" ]; then t=other
            else continue
            fi
            printf '%s\t%s\0' "$t" "$f"
          done
        elif [ -f "$p" ]; then
          printf 'F\n'
          head -c 65536 -- "$p"
        else
          echo "No such file or directory: $p" >&2
          exit 2
        fi
        """.ReplaceLineEndings("\n");

    private async Task<object> FilesAsync(Parameters p, CancellationToken token)
    {
        var name = p.Identifier("name");
        var path = p.ContainerPath("path", "/");
        var result = await runner.RunAsync(["container", "exec", name, "sh", "-c", FilesScript, "sh", path], token);
        if (result.Code is 126 or 127)
        {
            throw new InvalidOperationException($"'{name}' has no /bin/sh, so its files cannot be browsed. Use copy to transfer files instead.");
        }
        if (result.Code != 0)
        {
            throw new InvalidOperationException(Inspection.Failure(result, $"Browsing {path} in '{name}'") + " Browsing needs a running container with /bin/sh.");
        }
        return ParseFiles(path, result.Output);
    }

    public static object ParseFiles(string path, string output)
    {
        if (output.StartsWith("F\n", StringComparison.Ordinal))
        {
            var text = output[2..];
            var binary = text.Contains('\0');
            return new { path, entries = Array.Empty<FileEntry>(), text = binary ? null : text, binary, truncated = System.Text.Encoding.UTF8.GetByteCount(text) >= MaxFileText };
        }
        if (!output.StartsWith("D\n", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Unexpected listing output for {path}.");
        }
        var entries = output[2..].Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Select(item => item.Split('\t', 2))
            .Where(parts => parts.Length == 2)
            .Select(parts => new FileEntry(parts[1], parts[0]))
            .OrderBy(entry => entry.Type == "dir" ? 0 : 1)
            .ThenBy(entry => entry.Name, StringComparer.Ordinal)
            .ToList();
        return new { path, entries = entries.Take(MaxFileEntries).ToList(), truncated = entries.Count > MaxFileEntries };
    }
}
