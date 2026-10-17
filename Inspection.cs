using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Watcher;

public sealed record Limits(double? Cpus, long? MemoryBytes);

/// <summary>The detail drawer's view of <c>wslc container inspect</c>, with environment values and credential-like fields masked.</summary>
public sealed record ContainerDetail(
    string Name, JsonNode Raw, string Health, string State, int? ExitCode, IReadOnlyList<string> Command,
    string Image, string User, string WorkingDir, IReadOnlyList<string> Environment,
    JsonNode? Mounts, JsonNode? Networks, JsonNode? Ports, Limits Limits);

public sealed record LogEntry(string Container, string Text, string Time);

/// <summary>Pure parsing and masking of wslc JSON output.</summary>
public static partial class Inspection
{
    public const string Mask = "••••";

    /// <summary>
    /// <c>inspect --format json</c> prints one array per line and <c>list --format json</c> one object per line;
    /// both become a flat list of objects.
    /// </summary>
    public static List<JsonObject> Objects(string output)
    {
        var objects = new List<JsonObject>();
        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith('{') && !trimmed.StartsWith('['))
            {
                continue;
            }
            switch (JsonNode.Parse(trimmed))
            {
                case JsonObject single:
                    objects.Add(single);
                    break;
                case JsonArray array:
                    objects.AddRange(array.OfType<JsonObject>().Select(item => (JsonObject)item.DeepClone()));
                    break;
            }
        }
        return objects;
    }

    /// <summary>Masks environment values and credential-like keys anywhere in the tree; returns the same node.</summary>
    public static JsonNode? Masked(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (key, value) in obj.ToList())
                {
                    if (value is JsonArray env && key.Equals("Env", StringComparison.OrdinalIgnoreCase))
                    {
                        obj[key] = new JsonArray(env.Select(item => (JsonNode?)MaskAssignment(item?.ToString() ?? "", always: true)).ToArray());
                    }
                    else if (value is JsonValue && IsSecretKey(key))
                    {
                        obj[key] = Mask;
                    }
                    else
                    {
                        Masked(value);
                    }
                }
                break;
            case JsonArray array:
                var hideNext = false;
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is JsonValue value && value.GetValueKind() == JsonValueKind.String)
                    {
                        var text = value.GetValue<string>();
                        var masked = MaskAssignment(text, always: false);
                        // Command-style arrays (Cmd, Entrypoint, Healthcheck) hold more than KEY=value pairs;
                        // credential-bearing entries such as bearer tokens must not survive masking either.
                        if (masked == text && SensitiveText(text)) masked = Mask;
                        array[i] = hideNext ? Mask : masked;
                        hideNext = !hideNext && text.StartsWith('-') && !text.Contains('=') && IsSecretKey(text);
                    }
                    else
                    {
                        Masked(array[i]);
                    }
                }
                break;
        }
        return node;
    }

    public static long EventTime(JsonElement entry, long fallback)
    {
        foreach (var key in new[] { "timeNano", "TimeNano", "time", "Time" })
        {
            if (!entry.TryGetProperty(key, out var value) || !long.TryParse(value.ToString(), out var number)) continue;
            try { return checked(key.EndsWith("Nano", StringComparison.Ordinal) ? number / 1_000_000 : number * 1000); }
            catch (OverflowException) { }
        }
        return fallback;
    }

    /// <summary>"KEY=value" becomes "KEY=••••" when <paramref name="always"/> or the key looks like a credential.</summary>
    public static string MaskAssignment(string text, bool always)
    {
        var equals = text.IndexOf('=');
        if (equals < 0)
        {
            return always ? Mask : text;
        }
        return always || IsSecretKey(text[..equals]) ? $"{text[..equals]}={Mask}" : text;
    }

    public static bool IsSecretKey(string key) => SecretKey().IsMatch(key);

    [GeneratedRegex(@"pass(word|wd)?|secret|token|credential|authorization|auth(?!or)|signature|\bsig\b|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?key", RegexOptions.IgnoreCase)]
    private static partial Regex SecretKey();

    /// <summary>Free text (command arguments, log or file lines) that carries a credential even without a KEY= head.</summary>
    [GeneratedRegex(@"\b(bearer|basic)\s+\S|authorization\s*[:=]|\b(api[-_]?key|secret|password|passwd|token|credential|private[-_]?key|access[-_]?key)\s*[:=]\s*\S", RegexOptions.IgnoreCase)]
    private static partial Regex SensitiveTextPattern();

    private static bool SensitiveText(string text) => SensitiveTextPattern().IsMatch(text);

    /// <summary>Masks credential-bearing lines in file or log text before it reaches the renderer.</summary>
    public static string MaskText(string text) =>
        string.Join('\n', text.Split('\n').Select(line =>
        {
            var plain = line.TrimEnd('\r');
            var masked = MaskAssignment(plain, always: false);
            return masked != plain || !SensitiveText(plain) ? masked : Mask;
        }));

    public static ContainerDetail Detail(JsonObject inspect)
    {
        var raw = (JsonObject)Masked(inspect.DeepClone())!;
        var config = raw["Config"] as JsonObject;
        var state = raw["State"] as JsonObject;
        var host = raw["HostConfig"] as JsonObject;
        var command = Strings(config?["Entrypoint"]).Concat(Strings(config?["Cmd"])).ToList();
        var nanoCpus = Number(host?["NanoCpus"]);
        var memory = Number(host?["Memory"]);

        return new ContainerDetail(
            Name: (raw["Name"]?.ToString() ?? "").TrimStart('/'),
            Raw: raw,
            Health: state?["Health"] is JsonObject health ? health["Status"]?.ToString() ?? "unknown" : "none",
            State: state?["Status"]?.ToString() ?? "",
            ExitCode: state?["ExitCode"] is JsonValue code && code.TryGetValue<int>(out var exit) ? exit : null,
            Command: command,
            Image: config?["Image"]?.ToString() ?? raw["Image"]?.ToString() ?? "",
            User: config?["User"]?.ToString() ?? "",
            WorkingDir: config?["WorkingDir"]?.ToString() ?? "",
            Environment: Strings(config?["Env"]).ToList(),
            Mounts: raw["Mounts"]?.DeepClone(),
            Networks: (raw["NetworkSettings"] as JsonObject)?["Networks"]?.DeepClone(),
            Ports: raw["Ports"]?.DeepClone(),
            Limits: new Limits(nanoCpus > 0 ? nanoCpus / 1e9 : null, memory > 0 ? (long)memory : null));
    }

    private static IEnumerable<string> Strings(JsonNode? node) =>
        node is JsonArray array ? array.Select(item => item?.ToString() ?? "") : [];

    private static double Number(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<double>(out var number) ? number : 0;

    /// <summary><c>logs --timestamps</c> lines: "2026-10-16T21:09:31.829035057Z text". The time is kept as printed.</summary>
    public static IEnumerable<LogEntry> LogLines(string container, string output) =>
        output.Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .Select(line => new LogEntry(container, line, LogTime().Match(line) is { Success: true } match ? match.Value : ""));

    /// <summary>Timestamps trimmed of trailing zeros still sort correctly once the fraction is padded to nine digits.</summary>
    public static string SortKey(string time) =>
        LogFraction().Match(time) is { Success: true } match
            ? $"{match.Groups[1].Value}.{match.Groups[2].Value.PadRight(9, '0')}{match.Groups[3].Value}"
            : time.Length > 19 ? $"{time[..19]}.000000000{time[19..]}" : time;

    [GeneratedRegex(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)(?=\s|$)")]
    private static partial Regex LogTime();

    [GeneratedRegex(@"^(.{19})\.(\d+)(.*)$")]
    private static partial Regex LogFraction();

    /// <summary>A --since/--until value wslc accepts: unix seconds or RFC3339.</summary>
    public static bool IsTimestamp(string text) =>
        Regex.IsMatch(text, @"^\d{1,12}(\.\d{1,9})?$")
        || Regex.IsMatch(text, @"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$")
            && DateTimeOffset.TryParse(Regex.Replace(text, @"(\.\d{7})\d+", "$1"), CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    /// <summary>wslc errors end with an error code and a "please file an issue" line that helps nobody here.</summary>
    public static string Failure(CommandResult result, string action)
    {
        var lines = result.Combined.Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0 && line != "[]" && !line.StartsWith("If this error was unexpected", StringComparison.Ordinal))
            .ToList();
        return lines.Count == 0 ? $"{action} failed with exit code {result.Code}." : $"{action} failed: {string.Join(" ", lines)}";
    }
}
