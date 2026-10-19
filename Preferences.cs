using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Watcher;

public sealed record AlertPreferences(double CpuHigh = 50, double CpuRecovery = 25, double MemoryHigh = 90,
    double MemoryRecovery = 80, int Samples = 3, int CooldownSeconds = 60, bool Notifications = false, bool Muted = false);

public sealed record Preferences(string Session = "", bool KeepRunning = false, bool StartAtLogin = false,
    AlertPreferences? Alerts = null, IReadOnlyDictionary<string, AlertPreferences>? ContainerAlerts = null,
    ResourceLimits? Limits = null, IReadOnlyDictionary<string, ResourceLimits>? ContainerLimits = null)
{
    public static readonly string Root = Environment.GetEnvironmentVariable("WATCHER_DATA_FOLDER")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Watcher");
    public static readonly string FilePath = Path.Combine(Root, "preferences.json");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly Lazy<Preferences> Initial = new(() => Load());
    public static Preferences Startup => Initial.Value;
    public AlertPreferences EffectiveAlerts => Alerts ?? new();

    /// <summary>A container's own limits replace the defaults; an override with every limit off exempts it.</summary>
    public ResourceLimits LimitsFor(string container) => ContainerLimits?.GetValueOrDefault(container) ?? Limits ?? new();

    public static Preferences Load(string? path = null)
    {
        path ??= FilePath;
        try { return (JsonSerializer.Deserialize<Preferences>(File.ReadAllText(path), Json)
            ?? throw new JsonException("Preferences cannot be null.")).Validated(); }
        catch (FileNotFoundException) { return new(); }
        catch (DirectoryNotFoundException) { return new(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            throw new InvalidOperationException($"Watcher could not read {path}. No WSLc session was selected. Fix or restore this file before restarting Watcher.\n\n{e.Message}", e);
        }
    }

    public Preferences Validated()
    {
        if (Session is null || Session.Length > 200 || Session.Any(char.IsControl)) throw new ArgumentException("Invalid session name.");
        ValidateAlerts(EffectiveAlerts);
        foreach (var rule in ContainerAlerts?.Values ?? []) ValidateAlerts(rule);
        ResourceLimits.Validate(Limits ?? new());
        foreach (var limits in ContainerLimits?.Values ?? []) ResourceLimits.Validate(limits);
        return this;
    }

    public static void ValidateAlerts(AlertPreferences rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        if (!double.IsFinite(rule.CpuHigh) || !double.IsFinite(rule.CpuRecovery)
            || !double.IsFinite(rule.MemoryHigh) || !double.IsFinite(rule.MemoryRecovery)
            || rule.CpuHigh is <= 0 or > 100 || rule.CpuRecovery < 0 || rule.CpuRecovery >= rule.CpuHigh
            || rule.MemoryHigh is <= 0 or > 100 || rule.MemoryRecovery < 0 || rule.MemoryRecovery >= rule.MemoryHigh
            || rule.Samples is < 1 or > 600 || rule.CooldownSeconds is < 0 or > 86400)
            throw new ArgumentException("Alert recovery must be below its threshold; thresholds are 1–100%, samples 1–600 and cooldown 0–86400 seconds.");
    }

    public void Save()
    {
        Validated();
        Directory.CreateDirectory(Root);
        var temporary = FilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Json));
        File.Move(temporary, FilePath, overwrite: true);
    }

    public static string SessionFolder(string session) => session.Length == 0 ? Root
        : Path.Combine(Root, "sessions", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(session)))[..16].ToLowerInvariant());
}
