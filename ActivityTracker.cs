using System.Text.Json.Nodes;

namespace Watcher;

/// <summary>A page's {type:"container", name, op, source}; source is "reap" from the Reap button, "limit" from enforcement, else "row".</summary>
public sealed record ContainerRequest(string Name, string Op, string Source = "row");

/// <summary>
/// Turns the poll loop's snapshots and failures into activity events: the container diff, the per-container
/// alert machines, and monitor and wslc transitions.
/// </summary>
/// <param name="persisted">Containers the store last saw, or null on a brand-new database.</param>
public sealed class ActivityTracker(IReadOnlyDictionary<string, ContainerInfo>? persisted)
{
    private const int OutputLimit = 2_000;

    private readonly Dictionary<(string Container, Threshold Threshold), Alert> _alerts = [];
    private Dictionary<string, ContainerInfo>? _previous;
    private bool _started;
    private bool _offline;
    private Preferences _preferences = new();

    public void Configure(Preferences preferences)
    {
        _preferences = preferences;
        foreach (var key in _alerts.Keys.ToList())
        {
            var rule = preferences.ContainerAlerts?.GetValueOrDefault(key.Container) ?? preferences.EffectiveAlerts;
            var cpu = key.Threshold.Metric == "CPU";
            if (key.Threshold.High != (cpu ? rule.CpuHigh : rule.MemoryHigh)
                || key.Threshold.Low != (cpu ? rule.CpuRecovery : rule.MemoryRecovery)
                || key.Threshold.RequiredSamples != rule.Samples) _alerts.Remove(key);
        }
    }

    /// <param name="wslCpus">WSL's processor count now, which CPU alerts are a share of.</param>
    public IReadOnlyList<ActivityEvent> Observe(Snapshot snapshot, int wslCpus)
    {
        var at = snapshot.At;
        var current = snapshot.Containers.ToDictionary(c => c.Info.Name, c => c.Info);
        var events = new List<ActivityEvent>();
        if (!_started)
        {
            events.Add(Started(at, current.Values));
        }
        if (_offline)
        {
            _offline = false;
            events.Add(new ActivityEvent(at, ActivityKind.WslcOnline, null, "wslc is reachable again"));
        }
        // A brand-new database has no baseline: everything already running is listed in monitor-started instead.
        if (_previous is not null || persisted is not null)
        {
            events.AddRange(Activity.Diff(_previous ?? persisted!, current, at, whileClosed: _previous is null));
        }
        events.AddRange(Alerts(snapshot, wslCpus));
        _previous = current;

        return events;
    }

    /// <summary>A failed snapshot; only the transition to offline is an event.</summary>
    public IReadOnlyList<ActivityEvent> Offline(long at, string message)
    {
        var events = new List<ActivityEvent>();
        if (!_started)
        {
            events.Add(Started(at, []));
        }
        if (!_offline)
        {
            _offline = true;
            events.Add(new ActivityEvent(at, ActivityKind.WslcOffline, null, $"wslc is unreachable: {message}", new() { ["message"] = message }));
        }

        return events;
    }

    public static ActivityEvent Stopped(long at) => new(at, ActivityKind.MonitorStopped, null, "Monitor stopped");

    public ActivityEvent Action(long at, ContainerRequest request, bool ok, string output, long ms)
    {
        var (name, op) = (request.Name, request.Op);
        var title = _previous?.GetValueOrDefault(name)?.Title ?? name;
        var trimmed = output.Trim();
        if (trimmed.Length > OutputLimit)
        {
            trimmed = trimmed[..OutputLimit];
        }
        var seconds = $"{ms / 1000d:0.0} s";
        var summary = ok
            ? $"{op switch { "stop" => "Stopped", "start" => "Started", "restart" => "Restarted", _ => "Removed" }} {title} ({seconds})"
            : $"wslc {op} failed for {title} after {seconds}: {trimmed.Split('\n')[0].Trim()}";

        return new ActivityEvent(at, ActivityKind.Action, name, summary,
            new() { ["op"] = op, ["source"] = request.Source, ["ok"] = ok, ["output"] = trimmed, ["ms"] = ms });
    }

    private ActivityEvent Started(long at, IEnumerable<ContainerInfo> containers)
    {
        _started = true;
        var list = containers.ToList();
        var running = list.Count(c => c.State == "running");

        return new ActivityEvent(at, ActivityKind.MonitorStarted, null,
            $"Monitor started: {list.Count} {(list.Count == 1 ? "container" : "containers")}, {running} running",
            new()
            {
                ["containers"] = new JsonArray(list.Select(c => (JsonNode)new JsonObject
                {
                    ["name"] = c.Name, ["title"] = c.Title, ["state"] = c.State, ["orphan"] = c.Orphan,
                }).ToArray()),
            });
    }

    /// <summary>A stopped or removed container starts over at normal, without an event; its state change says why.</summary>
    private List<ActivityEvent> Alerts(Snapshot snapshot, int wslCpus)
    {
        var events = new List<ActivityEvent>();
        var measured = snapshot.Containers.Where(c => c.Metrics is not null).ToDictionary(c => c.Info.Name);
        foreach (var key in _alerts.Keys.Where(key => !measured.ContainsKey(key.Container)).ToList())
        {
            _alerts.Remove(key);
        }
        foreach (var view in measured.Values)
        {
            var rule = _preferences.ContainerAlerts?.GetValueOrDefault(view.Info.Name) ?? _preferences.EffectiveAlerts;
            var thresholds = new[]
            {
                Activity.Thresholds[0] with { High = rule.CpuHigh, Low = rule.CpuRecovery, RequiredSamples = rule.Samples },
                Activity.Thresholds[1] with { High = rule.MemoryHigh, Low = rule.MemoryRecovery, RequiredSamples = rule.Samples },
            };
            foreach (var threshold in thresholds)
            {
                var key = (view.Info.Name, threshold);
                var value = threshold.Read(view.Metrics!, wslCpus);
                var (next, flipped) = Activity.Step(_alerts.GetValueOrDefault(key), value, threshold);
                _alerts[key] = next;
                if (flipped)
                {
                    events.Add(Activity.Flipped(snapshot.At, view.Info, threshold, next.Level, value));
                }
            }
        }

        return events;
    }
}
