using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Watcher;

/// <summary>
/// Inspection and management of existing wslc workloads for the main window. Every call goes through the injected
/// runner with a fixed argument list; nothing here creates containers, networks, volumes or images.
/// </summary>
/// <param name="session">The session the runner targets; empty is wslc's default. Only used to find its storage folder.</param>
/// <param name="storageRoot">Where wslc keeps per-session disks; tests point this at a temporary folder.</param>
public sealed partial class Management(ICommandRunner runner, string? session = null, string? storageRoot = null)
{
    public const int MaxLogContainers = 20;
    public const int MaxLogLines = 5000;
    private static readonly TimeSpan Transfer = TimeSpan.FromMinutes(30);

    private readonly string _session = session ?? Wslc.Session;
    private readonly string _storageRoot = storageRoot
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wslc", "sessions");

    public TimeProvider Clock { get; init; } = TimeProvider.System;

    public async Task<object?> HandleAsync(string operation, JsonElement parameters, CancellationToken token = default)
    {
        var p = new Parameters(parameters);
        return operation switch
        {
            "inspect" => Inspection.Detail(await InspectAsync("container", p.Identifier("name"), token)),
            "logs" => await LogsAsync(p, token),
            "inventory" => await InventoryAsync(p.Kind(), token),
            "object-inspect" => new { raw = Inspection.Masked(await InspectAsync(p.Kind(), p.Identifier("name"), token)) },
            "object-remove" => await RemoveAsync(p, token),
            "network-connect" => await ConnectAsync(p, token),
            "copy" => await CopyAsync(p, token),
            "image-save" => await SaveImageAsync(p, token),
            "volume-backup" => await BackupVolumeAsync(p, token),
            "files" => await FilesAsync(p, token),
            "runtime" => await RuntimeAsync(token),
            "storage" => await StorageAsync(token),
            "events" => await EventsAsync(p, token),
            "diagnose" => await DiagnoseAsync(p, token),
            _ => throw new ArgumentException($"Unknown management operation '{operation}'."),
        };
    }

    private async Task<CommandResult> RunAsync(string action, IReadOnlyList<string> arguments, CancellationToken token, TimeSpan? timeout = null)
    {
        var result = await runner.RunAsync(arguments, token, timeout);
        if (result.Code != 0)
        {
            throw new InvalidOperationException(Inspection.Failure(result, action));
        }
        return result;
    }

    private async Task ChangeAsync(string action, IReadOnlyList<string> arguments, CancellationToken token, TimeSpan? timeout = null, string? outputPath = null)
    {
        try { await RunAsync(action, arguments, token, timeout); }
        catch (Exception e)
        {
            var warning = outputPath is null ? "" : $" A partial copy may remain at {outputPath}; check it before using or retrying it.";
            Exception failure = e is OperationCanceledException
                ? new OperationCanceledException("Operation cancelled." + warning, e, token)
                : new InvalidOperationException(e.Message + warning, e);
            failure.Data["actionSent"] = true;
            if (outputPath is not null) failure.Data["partialOutput"] = outputPath;
            throw failure;
        }
    }

    /// <summary>Not-found exits non-zero with "[]" on stdout, so both cases end in a readable error.</summary>
    private async Task<JsonObject> InspectAsync(string kind, string name, CancellationToken token)
    {
        var result = await RunAsync($"Inspecting {kind} '{name}'", [kind, "inspect", "--format", "json", name], token);
        return Inspection.Objects(result.Output).FirstOrDefault() ?? throw new InvalidOperationException($"No {kind} named '{name}'.");
    }

    /// <summary>Finite snapshots (never --follow) of one or more containers, merged in timestamp order.</summary>
    private async Task<object> LogsAsync(Parameters p, CancellationToken token)
    {
        var names = p.Identifiers("names");
        if (names.Count > MaxLogContainers)
        {
            throw new ArgumentException($"Logs can be read from at most {MaxLogContainers} containers at once.");
        }
        var tail = p.Number("tail", 200, 1, MaxLogLines);
        var since = p.Timestamp("since");
        var until = p.Timestamp("until");
        var entries = new List<LogEntry>();
        var truncated = false;
        foreach (var name in names)
        {
            List<string> args = ["container", "logs", "--timestamps", "--tail", tail.ToString(CultureInfo.InvariantCulture)];
            if (since.Length > 0) args.AddRange(["--since", since]);
            if (until.Length > 0) args.AddRange(["--until", until]);
            args.Add(name);
            var result = await RunAsync($"Reading logs of '{name}'", args, token);
            // wslc relays the container's stderr on its own stderr, so a successful run has log lines on both streams.
            // Log text comes from the container's owner, so credential-bearing lines are masked before rendering.
            entries.AddRange(Inspection.LogLines(name, result.Output).Select(entry => entry with { Text = Inspection.MaskText(entry.Text) }));
            entries.AddRange(Inspection.LogLines(name, result.Error).Select(entry => entry with { Text = Inspection.MaskText(entry.Text) }));
            truncated |= result.Truncated;
        }
        return new { entries = entries.OrderBy(entry => Inspection.SortKey(entry.Time), StringComparer.Ordinal).ToList(), truncated };
    }

    private async Task<object> InventoryAsync(string kind, CancellationToken token)
    {
        var result = await RunAsync($"Listing {kind}s", [kind, "list", "--format", "json"], token);
        return new { items = Inspection.Objects(result.Output).Select(Inspection.Masked).ToList() };
    }

    private async Task<object> EventsAsync(Parameters p, CancellationToken token)
    {
        var now = Clock.GetUtcNow().ToUnixTimeSeconds();
        var since = p.Timestamp("since") is { Length: > 0 } given ? given : (now - 3600).ToString(CultureInfo.InvariantCulture);
        var until = now.ToString(CultureInfo.InvariantCulture);
        // --until makes this a bounded query instead of a stream that never exits.
        var result = await RunAsync("Reading runtime events", ["system", "events", "--format", "json", "--since", since, "--until", until], token);
        if (result.Truncated)
        {
            throw new InvalidOperationException($"Runtime events from {since} to {until} exceeded the output limit, so some were not read.");
        }
        return new { entries = Inspection.Objects(result.Output).Select(Inspection.Masked).ToList(), since, until };
    }

    /// <summary>Validated access to the page's parameters; every identifier and path is checked before any command runs.</summary>
    private readonly struct Parameters(JsonElement element)
    {
        private bool Has(string key, out JsonElement value)
        {
            value = default;
            return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(key, out value)
                && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined);
        }

        public string Text(string key, string fallback = "")
        {
            if (!Has(key, out var value)) return fallback;
            if (value.ValueKind != JsonValueKind.String) throw new ArgumentException($"{key} must be text.");
            var text = value.GetString()!;
            if (text.Length > 4096 || text.Any(char.IsControl)) throw new ArgumentException($"Invalid {key}.");
            return text;
        }

        public string Required(string key) =>
            Text(key) is { Length: > 0 } text && !string.IsNullOrWhiteSpace(text) ? text : throw new ArgumentException($"{key} is required.");

        /// <summary>A container, image, volume or network name that wslc cannot mistake for an option.</summary>
        public string Identifier(string key) => CheckIdentifier(Required(key), key);

        private static string CheckIdentifier(string name, string key) =>
            name.StartsWith('-') || name.Length > 256 || name.Any(char.IsWhiteSpace)
                ? throw new ArgumentException($"Invalid {key} '{name}'.")
                : name;

        public IReadOnlyList<string> Identifiers(string key)
        {
            if (!Has(key, out var value) || value.ValueKind != JsonValueKind.Array) throw new ArgumentException($"{key} must be a list.");
            var names = value.EnumerateArray()
                .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString()! : throw new ArgumentException($"{key} must hold names."))
                .Select(name => CheckIdentifier(name, key))
                .Distinct()
                .ToList();
            return names.Count > 0 ? names : throw new ArgumentException($"{key} is required.");
        }

        public bool Flag(string key) => Has(key, out var value) && value.ValueKind == JsonValueKind.True;

        public int Number(string key, int fallback, int min, int max)
        {
            if (!Has(key, out var value)) return fallback;
            return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number >= min && number <= max
                ? number
                : throw new ArgumentException($"{key} must be a whole number from {min} to {max}.");
        }

        public string Kind() => Required("kind") is ("image" or "volume" or "network") and var kind
            ? kind
            : throw new ArgumentException("kind must be image, volume or network.");

        public string Timestamp(string key) => Text(key).Trim() is var text && (text.Length == 0 || Inspection.IsTimestamp(text))
            ? text
            : throw new ArgumentException($"{key} must be unix seconds or an RFC3339 time such as 2024-01-15T10:30:00Z.");

        public void Confirm(string action)
        {
            if (!Flag("confirmed")) throw new InvalidOperationException($"{action} needs explicit confirmation.");
        }

        /// <summary>A path inside the container: absolute and plain.</summary>
        public string ContainerPath(string key, string fallback = "")
        {
            var path = Text(key, fallback);
            return path.StartsWith('/') ? path : throw new ArgumentException($"{key} must be an absolute path inside the container, such as /var/log.");
        }

        /// <summary>A fully qualified Windows path, so wslc can never read it as CONTAINER:PATH or an option.</summary>
        public string HostPath(string key)
        {
            var path = Required(key);
            if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\?\", StringComparison.Ordinal) || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0)
            {
                throw new ArgumentException($"{key} must be a full Windows path such as C:\\backups\\data.");
            }
            return Path.GetFullPath(path);
        }
    }
}
