using System.Text.Json;
using System.Text.Json.Nodes;

namespace Watcher;

/// <summary>A container's identity and observed state, from <c>wslc list</c>; <paramref name="Created"/> is unix ms.</summary>
public sealed record ContainerInfo(
    string Name, string Title, string? Path, string? Group, string? Branch,
    string Image, string State, bool Orphan, string Port, string Uptime, long? Created = null)
{
    public bool HasPath => Path is not null;
}

/// <summary>One <c>wslc stats</c> sample; <paramref name="Cpu"/> is cores busy, net and disk are the cumulative counters wslc reports.</summary>
public sealed record Metrics(
    double Cpu, double MemoryBytes, double MemoryLimitBytes, double MemoryPercent,
    double NetIn, double NetOut, double DiskRead, double DiskWrite, int Pids);

public sealed record ContainerView(ContainerInfo Info, Metrics? Metrics, double[] CpuHistory, double[] MemoryHistory)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The flat row web/containers.js reads: info, then metrics and histories while running.</summary>
    public JsonObject ToPage()
    {
        var row = JsonSerializer.SerializeToNode(Info, Json)!.AsObject();
        if (Metrics is not { } metrics)
        {
            return row;
        }
        foreach (var (key, value) in JsonSerializer.SerializeToNode(metrics, Json)!.AsObject())
        {
            row[key] = value?.DeepClone();
        }
        row["cpuHistory"] = JsonSerializer.SerializeToNode(CpuHistory);
        row["memoryHistory"] = JsonSerializer.SerializeToNode(MemoryHistory);

        return row;
    }
}

/// <summary>One refresh of every container; <paramref name="At"/> is unix milliseconds, UTC.</summary>
public sealed record Snapshot(long At, IReadOnlyList<ContainerView> Containers)
{
    public object ToPage(Capacities capacity) => new { type = "snapshot", capacity, containers = Containers.Select(c => c.ToPage()).ToList() };
}
