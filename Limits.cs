using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Watcher;

/// <summary>What Watcher does when a container goes over a limit. wslc has no pause, so Stop is the reversible choice.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<LimitAction>))]
public enum LimitAction
{
    [JsonStringEnumMemberName("log")] Log,
    [JsonStringEnumMemberName("stop")] Stop,
    [JsonStringEnumMemberName("remove")] Remove,
}

/// <summary>One enforced ceiling; a null <see cref="Limit"/> on a rule means that ceiling is off.</summary>
public sealed record Limit(double Value, LimitAction Action = LimitAction.Log);

/// <summary>
/// The ceilings Watcher enforces on one container. Memory is GiB used, CPU is % of WSL and age is hours since creation.
/// CPU and memory must stay over for <paramref name="Samples"/> polls in a row; age acts on the first poll.
/// </summary>
public sealed record ResourceLimits(Limit? MemoryGiB = null, Limit? CpuPercent = null, Limit? AgeHours = null, int Samples = 15)
{
    public static void Validate(ResourceLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.Samples is < 1 or > 600) throw new ArgumentException("Limit samples must be a whole number from 1 to 600.");
        foreach (var rule in LimitRule.All)
        {
            if (rule.Of(limits) is not { } limit) continue;
            if (!double.IsFinite(limit.Value) || limit.Value <= 0 || limit.Value > rule.Max || !Enum.IsDefined(limit.Action))
                throw new ArgumentException($"The {rule.Name} limit must be above 0 and at most {rule.Max} {rule.Unit}.");
        }
    }
}

/// <summary>
/// One kind of ceiling. <see cref="Read"/> takes a container, WSL's processor count and now (unix ms) and returns
/// the value to compare, or null when it cannot be measured.
/// </summary>
public sealed record LimitRule(string Key, string Name, string Unit, double Max, bool Sustained,
    Func<ResourceLimits, Limit?> Of, Func<ContainerView, int, long, double?> Read)
{
    public static readonly LimitRule[] All =
    [
        new("memory", "memory", "GiB", 1024, Sustained: true, l => l.MemoryGiB,
            (c, _, _) => c.Metrics is { } m ? m.MemoryBytes / (1024d * 1024 * 1024) : null),
        new("cpu", "CPU", "% of WSL", 100, Sustained: true, l => l.CpuPercent,
            (c, cpus, _) => c.Metrics is { } m && cpus > 0 ? m.Cpu / cpus * 100 : null),
        new("age", "age", "hours", 24 * 365, Sustained: false, l => l.AgeHours,
            (c, _, now) => c.Info.Created is { } created ? (now - created) / 3_600_000d : null),
    ];
}

/// <summary>A container that has just gone over one of its limits; the enforcer reports it once per crossing.</summary>
public sealed record Breach(ContainerInfo Info, LimitRule Rule, double Value, Limit Limit, int Samples)
{
    public string Operation => Limit.Action switch { LimitAction.Stop => "stop", LimitAction.Remove => "remove", _ => "" };

    public ActivityEvent ToEvent(long at)
    {
        var over = $"{Number(Value)} {Rule.Unit} ≥ {Number(Limit.Value)} {Rule.Unit}";
        var held = Rule.Sustained ? $" for {Samples} samples" : "";
        var then = Limit.Action switch { LimitAction.Stop => "; stopping it", LimitAction.Remove => "; removing it", _ => "" };

        return new ActivityEvent(at, ActivityKind.Limit, Info.Name, $"{Info.Title} over its {Rule.Name} limit: {over}{held}{then}",
            new()
            {
                ["rule"] = Rule.Key, ["value"] = Math.Round(Value, 2), ["limit"] = Limit.Value,
                ["action"] = Operation.Length > 0 ? Operation : "log", ["samples"] = Samples,
            });
    }

    private static string Number(double value) => value.ToString(value >= 10 ? "0" : value >= 1 ? "0.#" : "0.###", CultureInfo.InvariantCulture);
}

/// <summary>
/// Turns snapshots into breaches. Each (container, rule) keeps a streak of polls over the limit; the breach fires on
/// the poll the streak reaches the required count and re-arms once the value is back under the limit.
/// </summary>
public sealed class LimitEnforcer
{
    private readonly Dictionary<(string Container, string Rule), int> _streaks = [];
    private Preferences _preferences = new();

    /// <summary>Keeps each streak whose container's limits did not change, so saving other settings never re-fires a breach.</summary>
    public void Configure(Preferences preferences)
    {
        var before = _preferences;
        _preferences = preferences;
        foreach (var key in _streaks.Keys.Where(key => before.LimitsFor(key.Container) != preferences.LimitsFor(key.Container)).ToList())
            _streaks.Remove(key);
    }

    public IReadOnlyList<Breach> Evaluate(Snapshot snapshot, int wslCpus)
    {
        var breaches = new List<Breach>();
        var seen = new HashSet<(string, string)>();
        foreach (var container in snapshot.Containers)
        {
            var limits = _preferences.LimitsFor(container.Info.Name);
            foreach (var rule in LimitRule.All)
            {
                if (rule.Of(limits) is not { } limit) continue;
                // Stopping only means something for a running container; Log and Remove also cover stopped ones.
                if (limit.Action == LimitAction.Stop && container.Info.State != "running") continue;
                if (rule.Read(container, wslCpus, snapshot.At) is not { } value || value < limit.Value) continue;
                var key = (container.Info.Name, rule.Key);
                seen.Add(key);
                var streak = _streaks.GetValueOrDefault(key) + 1;
                _streaks[key] = streak;
                var required = rule.Sustained ? limits.Samples : 1;
                if (streak == required) breaches.Add(new Breach(container.Info, rule, value, limit, required));
            }
        }
        foreach (var key in _streaks.Keys.Where(key => !seen.Contains(key)).ToList()) _streaks.Remove(key);

        return breaches;
    }
}
