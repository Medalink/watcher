using System.IO;
using System.Text.Json.Nodes;

namespace Watcher;

public sealed record Capabilities(bool Events, bool Health, bool Compose);

public sealed record StorageFile(string Path, long Bytes);

/// <summary>Runtime facts: version and sessions, what this wslc supports, and where its disks live.</summary>
public sealed partial class Management
{
    public const string StorageNote =
        "Removing images, containers or volumes frees space inside the disk image, but the .vhdx file on Windows does not shrink by itself.";

    private Capabilities? _capabilities;

    private async Task<object> RuntimeAsync(CancellationToken token)
    {
        var info = await InfoAsync(token);
        // Session listing has no JSON format; the table is passed through as text.
        var sessions = await RunAsync("Listing sessions", ["system", "session", "list"], token);
        return new
        {
            info = Inspection.Masked(info.DeepClone()),
            sessions = sessions.Output.TrimEnd(),
            session = _session,
            capabilities = _capabilities ??= await CapabilitiesAsync(token),
            // Read from info; running "wslc settings" would create the file.
            settingsPath = info["Client"]?["SettingsFile"]?.ToString() ?? "",
        };
    }

    private async Task<JsonObject> InfoAsync(CancellationToken token) =>
        Inspection.Objects((await RunAsync("Reading runtime information", ["system", "info", "--format", "json"], token)).Output).FirstOrDefault()
        ?? throw new InvalidOperationException("wslc system info printed no JSON.");

    /// <summary>Read from help text so a newer wslc lights features up without a Watcher update.</summary>
    private async Task<Capabilities> CapabilitiesAsync(CancellationToken token)
    {
        var commands = (await RunAsync("Reading wslc help", ["--help"], token)).Output;
        var run = (await RunAsync("Reading wslc run help", ["container", "run", "--help"], token)).Output;
        return new Capabilities(
            Events: HelpLists(commands, "events"),
            Health: run.Contains("--health-cmd", StringComparison.Ordinal),
            Compose: HelpLists(commands, "compose"));
    }

    private static bool HelpLists(string help, string command) =>
        help.Split('\n').Any(line => line.TrimStart().StartsWith(command + " ", StringComparison.Ordinal));

    /// <summary>The disks in each session folder, without descending into anything a user might have bind-mounted.</summary>
    private async Task<object> StorageAsync(CancellationToken token)
    {
        var name = _session;
        if (name.Length == 0)
        {
            // The default session is the CLI's own, named wslc-cli-<user>.
            var sessions = (await InfoAsync(token))["Server"]?["Sessions"] as JsonArray ?? [];
            name = sessions.Select(s => s?["Name"]?.ToString() ?? "").FirstOrDefault(n => n.StartsWith("wslc-cli-", StringComparison.Ordinal)) ?? "";
        }
        var folder = name.Length > 0 && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 ? Path.Combine(_storageRoot, name) : _storageRoot;
        var files = new List<StorageFile>();
        foreach (var directory in Folders(_storageRoot))
        {
            foreach (var file in Files(directory))
            {
                try { files.Add(new StorageFile(file, new FileInfo(file).Length)); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { files.Add(new StorageFile(file, -1)); }
            }
        }
        long? free = null, total = null;
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(_storageRoot))!);
            (free, total) = (drive.AvailableFreeSpace, drive.TotalSize);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException) { }

        return new
        {
            sessionFolder = name.Length > 0 && Directory.Exists(folder) ? folder : null,
            storageRoot = _storageRoot,
            files = files.OrderBy(f => f.Path, StringComparer.OrdinalIgnoreCase).ToList(),
            freeBytes = free,
            totalBytes = total,
            note = Directory.Exists(_storageRoot) ? StorageNote : $"No WSLc storage was found at {_storageRoot}. {StorageNote}",
        };
    }

    private static IEnumerable<string> Folders(string root)
    {
        try { return Directory.Exists(root) ? Directory.EnumerateDirectories(root).Prepend(root).ToList() : []; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return []; }
    }

    private static IEnumerable<string> Files(string folder)
    {
        try { return Directory.EnumerateFiles(folder).ToList(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return []; }
    }
}
