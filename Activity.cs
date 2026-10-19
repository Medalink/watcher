using System.Globalization;
using System.Text.Json.Nodes;

namespace Watcher;

/// <summary>Event kinds as stored in the events table and read by web/activity.js.</summary>
public static class ActivityKind
{
    public const string Appeared = "appeared";
    public const string Disappeared = "disappeared";
    public const string State = "state";
    public const string Orphaned = "orphaned";
    public const string Port = "port";
    public const string CpuHigh = "cpu-high";
    public const string CpuNormal = "cpu-normal";
    public const string MemoryHigh = "memory-high";
    public const string MemoryNormal = "memory-normal";
    public const string Action = "action";
    public const string Limit = "limit";
    public const string MonitorStarted = "monitor-started";
    public const string MonitorStopped = "monitor-stopped";
    public const string WslcOffline = "wslc-offline";
    public const string WslcOnline = "wslc-online";
}

/// <summary>Something the monitor observed; <paramref name="Summary"/> reads on its own without the detail.</summary>
public sealed record ActivityEvent(long At, string Kind, string? Container, string Summary, JsonObject? Detail = null);

/// <summary>An event as read back from the store, with its id and the container's title.</summary>
public sealed record StoredEvent(long Id, long At, string Kind, string? Container, string? Title, string Summary, JsonObject? Detail);

public enum Level { Normal, High }

/// <summary>One container's place in one hysteresis pair: its level and how many samples in a row argue for flipping.</summary>
public readonly record struct Alert(Level Level, int Streak);

/// <summary>
/// High after <see cref="Samples"/> samples at or above <paramref name="High"/>; normal after as many below <paramref name="Low"/>.
/// <paramref name="Read"/> takes a sample and WSL's processor count; the units finish the value and the mark in a summary.
/// </summary>
public sealed record Threshold(
    string Metric, string HighKind, string NormalKind, double High, double Low, string ValueUnit, string MarkUnit, Func<Metrics, int, double> Read)
{
    public const int Samples = 3;
    public int RequiredSamples { get; init; } = Samples;
}

/// <summary>Derives activity events from what the monitor observed.</summary>
public static class Activity
{
    public static readonly Threshold[] Thresholds =
    [
        new("CPU", ActivityKind.CpuHigh, ActivityKind.CpuNormal, High: 50, Low: 25, " % of WSL", " %", (m, wslCpus) => m.Cpu / wslCpus * 100),
        new("memory", ActivityKind.MemoryHigh, ActivityKind.MemoryNormal, High: 90, Low: 80, " %", " % of the limit", (m, _) => m.MemoryPercent),
    ];

    private sealed record Rule(
        string Kind, Func<ContainerInfo, ContainerInfo, bool> Applies,
        Func<ContainerInfo, ContainerInfo, string> Summary, Func<ContainerInfo, ContainerInfo, JsonObject> Detail);

    /// <summary>What can change on a container that is listed both times.</summary>
    private static readonly Rule[] Changes =
    [
        new(ActivityKind.State, (was, now) => was.State != now.State,
            (was, now) => $"{now.Title} {was.State} → {now.State}",
            (was, now) => new() { ["from"] = was.State, ["to"] = now.State }),
        new(ActivityKind.Orphaned, (was, now) => !was.Orphan && now.Orphan,
            (_, now) => $"{now.Title} orphaned: folder {now.Path} was deleted",
            (_, now) => new() { ["path"] = now.Path }),
        new(ActivityKind.Port, (was, now) => was.Port != now.Port,
            (was, now) => $"{now.Title} port {PortText(was.Port)} → {PortText(now.Port)}",
            (was, now) => new() { ["from"] = was.Port, ["to"] = now.Port }),
    ];

    /// <summary>
    /// Events between two observed states, keyed by container name. <paramref name="whileClosed"/> marks a diff
    /// against the state persisted when the monitor last ran.
    /// </summary>
    public static IReadOnlyList<ActivityEvent> Diff(
        IReadOnlyDictionary<string, ContainerInfo> previous, IReadOnlyDictionary<string, ContainerInfo> current, long at, bool whileClosed = false)
    {
        var events = new List<ActivityEvent>();
        void Add(string kind, ContainerInfo info, string summary, JsonObject detail)
        {
            if (whileClosed)
            {
                detail["whileClosed"] = true;
                summary += " while the monitor was closed";
            }
            events.Add(new ActivityEvent(at, kind, info.Name, summary, detail));
        }

        foreach (var now in current.Values)
        {
            if (!previous.TryGetValue(now.Name, out var was))
            {
                Add(ActivityKind.Appeared, now, $"{now.Title} appeared ({now.State}, {now.Image})",
                    new() { ["state"] = now.State, ["image"] = now.Image, ["path"] = now.Path, ["port"] = now.Port });
                continue;
            }
            foreach (var rule in Changes.Where(rule => rule.Applies(was, now)))
            {
                Add(rule.Kind, now, rule.Summary(was, now), rule.Detail(was, now));
            }
        }
        foreach (var was in previous.Values.Where(was => !current.ContainsKey(was.Name)))
        {
            Add(ActivityKind.Disappeared, was, $"{was.Title} disappeared (was {was.State})", new() { ["lastState"] = was.State });
        }

        return events;
    }

    /// <summary>Advances one alert by one sample; flipped is true on the sample that changes the level.</summary>
    public static (Alert Next, bool Flipped) Step(Alert alert, double value, Threshold threshold)
    {
        var (argues, flipTo) = alert.Level == Level.Normal ? (value >= threshold.High, Level.High) : (value < threshold.Low, Level.Normal);
        var streak = argues ? alert.Streak + 1 : 0;

        return streak >= threshold.RequiredSamples ? (new Alert(flipTo, 0), true) : (alert with { Streak = streak }, false);
    }

    public static ActivityEvent Flipped(long at, ContainerInfo info, Threshold threshold, Level level, double value)
    {
        var high = level == Level.High;
        var (comparison, mark) = high ? ("≥", threshold.High) : ("<", threshold.Low);

        return new ActivityEvent(at, high ? threshold.HighKind : threshold.NormalKind, info.Name,
            $"{info.Title} {threshold.Metric} {(high ? "high" : "normal")}: {Number(value)}{threshold.ValueUnit} ({threshold.RequiredSamples} samples {comparison} {Number(mark)}{threshold.MarkUnit})",
            new() { ["value"] = Math.Round(value, 1), ["threshold"] = mark, ["samples"] = threshold.RequiredSamples });
    }

    public static string Number(double value) => value.ToString(value >= 10 ? "0" : "0.#", CultureInfo.InvariantCulture);

    private static string PortText(string port) => port == "" ? "none" : port;
}
