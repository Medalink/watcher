using System.IO;
using System.Text.Json.Nodes;

namespace Watcher.Tests;

/// <summary>Hand-built containers, samples and stores.</summary>
internal static class Build
{
    /// <summary>A minute-aligned instant: 2027-01-15 08:00:00 UTC.</summary>
    public const long T0 = 1_800_000_000_000;
    public const long Second = 1_000;
    public const long Minute = 60_000;
    public const long Hour = 3_600_000;

    /// <summary>WSL and Windows differ in both processors and memory, so a swapped denominator shows.</summary>
    public static readonly Capacities Sizes = new(new Capacity(16, 48_125_120 * 1024d), new Capacity(32, 100_605_000_000), WslMeasured: true);

    public static ContainerInfo Info(string name, string state = "running", bool orphan = false, string port = "", string? group = null) =>
        new(name, $"app-{name}", $"C:/src/shop/app-{name}", group, Branch: null, "nginx:1.27", state, orphan, port, "");

    public static Metrics Sample(double cpu = 0, double memory = 0, double limit = 1_000, double netIn = 0, double netOut = 0,
        double diskRead = 0, double diskWrite = 0) =>
        new(cpu, memory, limit, memory / limit * 100, netIn, netOut, diskRead, diskWrite, Pids: 7);

    public static Snapshot Snapshot(long at, params (ContainerInfo Info, Metrics? Metrics)[] containers) =>
        new(at, containers.Select(c => new ContainerView(c.Info, c.Metrics, [], [])).ToList());

    public static ActivityEvent Event(long at, string kind, string? container = null, string summary = "something happened", JsonObject? detail = null) =>
        new(at, kind, container, summary, detail);
}

/// <summary>A store on a fresh temp file, deleted afterwards.</summary>
internal sealed class TempStore : IDisposable
{
    private readonly string _path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"watcher-test-{Guid.NewGuid():N}.db");

    public TempStore() => Store = new Store(_path);

    public Store Store { get; }

    public string Path => _path;

    public void Dispose()
    {
        Store.Dispose();
        foreach (var file in new[] { _path, $"{_path}-wal", $"{_path}-shm" })
        {
            File.Delete(file);
        }
    }
}
