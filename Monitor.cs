using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Watcher;

/// <summary>Polls wslc and keeps about five minutes of CPU and memory history per container.</summary>
public sealed partial class Monitor(Settings settings)
{
    public const int HistoryLength = 150;

    private readonly Dictionary<string, Tracked> _tracked = [];

    private sealed class Tracked
    {
        public readonly Queue<double> Cpu = new();
        public readonly Queue<double> Memory = new();
        public ContainerView View = null!;
    }

    /// <summary>Seeds the sparklines from the store so they are full straight after a restart.</summary>
    public void Preload(IReadOnlyDictionary<string, (double[] Cpu, double[] Memory)> history)
    {
        foreach (var (name, (cpu, memory)) in history)
        {
            var tracked = new Tracked();
            foreach (var (c, m) in cpu.Zip(memory).TakeLast(HistoryLength))
            {
                tracked.Cpu.Enqueue(c);
                tracked.Memory.Enqueue(m);
            }
            _tracked[name] = tracked;
        }
    }

    /// <summary>One refresh: the listing plus a stats sample (which takes about two seconds).</summary>
    public async Task<Snapshot> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        var runner = Wslc.Client;
        var stats = runner.RunAsync(["stats", "--format", "json"], cancellationToken);
        var listing = runner.RunAsync(["list", "--all", "--format", "json"], cancellationToken);
        await Task.WhenAll(stats, listing);
        var list = await listing;
        if (list.Code != 0)
        {
            throw new InvalidOperationException($"wslc list failed: {list.Output.Trim()}");
        }
        var measured = await stats;
        var sampled = measured.Code == 0 ? measured.Output : "";
        var at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var statsByName = Wslc.JsonLines(sampled).ToDictionary(row => row.Text("Name"));

        var seen = new HashSet<string>();
        foreach (var row in Wslc.JsonLines(list.Output))
        {
            var name = row.Text("Names");
            seen.Add(name);
            if (!_tracked.TryGetValue(name, out var tracked))
            {
                tracked = new Tracked();
                _tracked[name] = tracked;
            }
            var info = Describe(name, row, settings);
            var metrics = info.State == "running" && statsByName.GetValueOrDefault(name) is { } sample ? Measure(sample) : null;
            tracked.View = Track(tracked, info, metrics);
        }
        foreach (var gone in _tracked.Keys.Except(seen).ToList())
        {
            _tracked.Remove(gone);
        }

        return new Snapshot(at, _tracked.Values.Select(t => t.View).OrderBy(v => v.Info.Title, StringComparer.OrdinalIgnoreCase).ToList());
    }

    /// <summary>A missing folder whose parent still exists was deleted on purpose, so its container is orphaned.</summary>
    public static ContainerInfo Describe(string name, JsonElement row, Settings settings)
    {
        var labels = row.Text("Labels");
        string? First(IEnumerable<string> keys) => keys.Select(key => Wslc.Label(labels, key)).FirstOrDefault(value => value is not null);
        var path = First(settings.PathLabels);
        var folder = path?.TrimEnd('/', '\\');
        var exists = path is not null && Directory.Exists(path);
        var orphan = folder is not null && Path.IsPathFullyQualified(folder) && !exists && Directory.Exists(Path.GetDirectoryName(folder));

        return new ContainerInfo(
            Name: name,
            Title: Path.GetFileName(folder) is { Length: > 0 } leaf ? leaf : name,
            Path: path,
            Group: First(settings.GroupLabels),
            Branch: exists ? Wslc.Branch(path!) : null,
            Image: row.Text("Image"),
            State: row.Text("State"),
            Orphan: orphan,
            Port: HostAddress().Replace(PortTarget().Replace(row.Text("Ports"), ""), ""),
            Uptime: row.Text("Status").Replace("Up ", "").Replace("About an ", "1 ").Replace("About a ", "1 ").Replace("Less than a second", "just now"),
            Created: Wslc.Created(row.Text("CreatedAt")));
    }

    /// <summary>wslc reports CPU per core (400 % is four cores); Watcher keeps cores busy and divides at display time.</summary>
    private static Metrics Measure(JsonElement sample)
    {
        var usage = sample.Text("MemUsage").Split('/', StringSplitOptions.TrimEntries);
        var net = sample.Text("NetIO").Split('/', StringSplitOptions.TrimEntries);
        var block = sample.Text("BlockIO").Split('/', StringSplitOptions.TrimEntries);

        return new Metrics(
            Cpu: Wslc.Percent(sample.Text("CPUPerc")) / 100,
            MemoryBytes: Wslc.Bytes(usage[0]),
            MemoryLimitBytes: usage.Length > 1 ? Wslc.Bytes(usage[1]) : 0,
            MemoryPercent: Wslc.Percent(sample.Text("MemPerc")),
            NetIn: Wslc.Bytes(net[0]),
            NetOut: net.Length > 1 ? Wslc.Bytes(net[1]) : 0,
            DiskRead: Wslc.Bytes(block[0]),
            DiskWrite: block.Length > 1 ? Wslc.Bytes(block[1]) : 0,
            Pids: int.TryParse(sample.Text("PIDs"), out var pids) ? pids : 0);
    }

    private static ContainerView Track(Tracked tracked, ContainerInfo info, Metrics? metrics)
    {
        if (metrics is null)
        {
            tracked.Cpu.Clear();
            tracked.Memory.Clear();
            return new ContainerView(info, null, [], []);
        }
        Push(tracked.Cpu, metrics.Cpu);
        Push(tracked.Memory, metrics.MemoryPercent);

        return new ContainerView(info, metrics, tracked.Cpu.ToArray(), tracked.Memory.ToArray());
    }

    private static void Push(Queue<double> history, double value)
    {
        history.Enqueue(value);
        while (history.Count > HistoryLength)
        {
            history.Dequeue();
        }
    }

    /// <summary>"127.0.0.1:25435->5432/tcp" keeps only the host port.</summary>
    [GeneratedRegex(@"->\d+/\w+")]
    private static partial Regex PortTarget();

    [GeneratedRegex(@"(\d{1,3}\.){3}\d{1,3}:|\[::\]:")]
    private static partial Regex HostAddress();
}
