using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Watcher;

/// <summary>Thin wrapper over wslc.exe; every call is a separate process.</summary>
public static partial class Wslc
{
    /// <summary>Null when this machine's WSL has no container support.</summary>
    public static readonly string? Exe =
        Find(Environment.GetEnvironmentVariable("PATH"), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));

    /// <summary>wslc.exe from the search path, else from the folder WSL installs into.</summary>
    public static string? Find(string? searchPath, string programFiles) =>
        (searchPath ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(folder => folder.Trim('"'))
            .Append(Path.Combine(programFiles, "WSL"))
            .Select(folder => Path.Combine(folder, "wslc.exe"))
            .FirstOrDefault(File.Exists);

    public static readonly string Session = Preferences.Startup.Session;
    public static ICommandRunner Client => new CommandRunner(Exe ?? throw new InvalidOperationException("wslc.exe was not found."), Session);

    public static async Task<(int Code, string Output)> Run(params string[] args)
    {
        var result = await Client.RunAsync(args);
        return (result.Code, result.Combined);
    }

    /// <summary>wslc --format json prints one JSON object per line.</summary>
    public static IEnumerable<JsonElement> JsonLines(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith('{'))
            {
                continue;
            }
            using var document = JsonDocument.Parse(trimmed);
            yield return document.RootElement.Clone();
        }
    }

    public static string Text(this JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) ? value.ToString() : "";

    /// <summary>Labels arrive as one "k=v,k=v" string whose metadata value itself contains commas.</summary>
    public static string? Label(string labels, string key) =>
        Regex.Match(labels, $"(?:^|,){Regex.Escape(key)}=([^,]+)") is { Success: true } match ? match.Groups[1].Value : null;

    /// <summary>"2026-10-16 12:00:43 -0500 CDT" to unix ms; the zone abbreviation adds nothing the offset doesn't say.</summary>
    public static long? Created(string text) =>
        CreatedPattern().Match(text) is { Success: true } match
        && DateTimeOffset.TryParseExact($"{match.Groups[1].Value}{match.Groups[2].Value}:{match.Groups[3].Value}", "yyyy-MM-dd HH:mm:sszzz",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var created)
            ? created.ToUnixTimeMilliseconds()
            : null;

    [GeneratedRegex(@"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)")]
    private static partial Regex CreatedPattern();

    /// <summary>"1.248GiB" or "337.3MiB" to bytes.</summary>
    public static double Bytes(string size)
    {
        var match = SizePattern().Match(size.Trim());
        if (!match.Success)
        {
            return 0;
        }
        var value = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);

        return value * match.Groups[2].Value.ToLowerInvariant() switch
        {
            "kb" => 1e3, "mb" => 1e6, "gb" => 1e9, "tb" => 1e12,
            "kib" => 1024d, "mib" => 1024d * 1024, "gib" => 1024d * 1024 * 1024, "tib" => 1024d * 1024 * 1024 * 1024,
            _ => 1,
        };
    }

    [GeneratedRegex(@"^([\d.]+)\s*([a-zA-Z]*)$")]
    private static partial Regex SizePattern();

    public static double Percent(string text) =>
        double.TryParse(text.TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0;

    /// <summary>The branch checked out in a git worktree, or its short commit when detached.</summary>
    public static string? Branch(string worktree)
    {
        try
        {
            var dotGit = Path.Combine(worktree, ".git");
            var gitDir = File.Exists(dotGit)
                ? File.ReadAllText(dotGit).Trim().Replace("gitdir:", "").Trim()
                : dotGit;
            var head = File.ReadAllText(Path.Combine(gitDir, "HEAD")).Trim();

            return head.StartsWith("ref: refs/heads/") ? head["ref: refs/heads/".Length..] : $"detached @ {head[..Math.Min(9, head.Length)]}";
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }
}
