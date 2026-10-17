using System.Text.Json;
using System.Text.Json.Nodes;
using static Watcher.Tests.Build;

namespace Watcher.Tests;

public sealed class BridgeTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public void Snapshot_rows_keep_the_flat_field_names_the_page_reads()
    {
        var running = new ContainerView(Info("a", port: "25435") with { Branch = "main", Uptime = "2 hours", Created = T0 - Hour },
            new Metrics(1.25, 300, 1_000, 30, 1, 2, 3, 4, Pids: 9), [1, 1.25], [29, 30]);
        var stopped = new ContainerView(Info("b", "exited"), null, [], []);

        var json = JsonSerializer.Serialize(new Snapshot(T0, [running, stopped]).ToPage(Sizes), Json);

        Assert.Equal(
            """
            {"type":"snapshot","capacity":{"wsl":{"cpus":16,"memoryBytes":49280122880},"windows":{"cpus":32,"memoryBytes":100605000000},"wslMeasured":true},"containers":[
            {"name":"a","title":"app-a","path":"C:/src/shop/app-a","group":null,"branch":"main","image":"nginx:1.27","state":"running","orphan":false,"port":"25435","uptime":"2 hours","created":1799996400000,"hasPath":true,
            "cpu":1.25,"memoryBytes":300,"memoryLimitBytes":1000,"memoryPercent":30,"netIn":1,"netOut":2,"diskRead":3,"diskWrite":4,"pids":9,"cpuHistory":[1,1.25],"memoryHistory":[29,30]},
            {"name":"b","title":"app-b","path":"C:/src/shop/app-b","group":null,"branch":null,"image":"nginx:1.27","state":"exited","orphan":false,"port":"","uptime":"","created":null,"hasPath":true}]}
            """.ReplaceLineEndings(""),
            json);
    }

    [Fact]
    public void Activity_params_from_the_page_parse_into_a_query()
    {
        var query = JsonSerializer.Deserialize<ActivityQuery>("""{"before":12,"container":"a","kinds":["state","port"],"search":"x","limit":50}""", Json);
        var defaults = JsonSerializer.Deserialize<ActivityQuery>("{}", Json);

        Assert.Equal((12L, "a", "x", 50), (query!.Before, query.Container, query.Search, query.Limit));
        Assert.Equal(["state", "port"], query.Kinds!);
        Assert.Equal(new ActivityQuery(), defaults);
    }

    [Fact]
    public void A_container_request_carries_its_source_into_the_action_detail()
    {
        var tracker = new ActivityTracker(null);
        ContainerRequest Parse(string json) => JsonSerializer.Deserialize<ContainerRequest>(json, Json)!;

        var reap = tracker.Action(T0, Parse("""{"type":"container","name":"a","op":"remove","source":"reap"}"""), ok: true, "", 900);
        var row = tracker.Action(T0, Parse("""{"type":"container","name":"b","op":"remove"}"""), ok: true, "", 900);

        Assert.Equal("""{"op":"remove","source":"reap","ok":true,"output":"","ms":900}""", reap.Detail!.ToJsonString());
        Assert.Equal("""{"op":"remove","source":"row","ok":true,"output":"","ms":900}""", row.Detail!.ToJsonString());
    }

    [Fact]
    public void Removed_params_from_the_page_parse_into_a_query()
    {
        Assert.Equal(new RemovedQuery(Offset: 10, Limit: 0), JsonSerializer.Deserialize<RemovedQuery>("""{"offset":10,"limit":0}""", Json));
        Assert.Equal(new RemovedQuery(Offset: 0, Limit: 10), JsonSerializer.Deserialize<RemovedQuery>("{}", Json));
    }

    [Fact]
    public void A_removed_page_keeps_the_field_names_the_page_reads()
    {
        var item = new RemovedContainer("a", "app-a", "C:/src/shop/app-a", null, "nginx:1.27", "25435",
            FirstSeen: T0, RemovedAt: T0 + Hour, Removal.Reap, WasOrphan: true, HasFolder: false, PeakMemory: 300, AvgCpuCores: null);

        Assert.Equal(
            """{"items":[{"name":"a","title":"app-a","path":"C:/src/shop/app-a","group":null,"image":"nginx:1.27","port":"25435","firstSeen":1800000000000,"removedAt":1800003600000,"removedBy":"reap","wasOrphan":true,"hasFolder":false,"peakMemory":300,"avgCpuCores":null}],"total":1}""",
            JsonSerializer.Serialize(new RemovedPage([item], 1), Json));
    }

    private static string Export(Capacities capacity)
    {
        using var temp = new TempStore();
        temp.Store.Write(Snapshot(T0 - 10 * Minute, (Info("a"), Sample(cpu: 8, memory: 512 * 1024 * 1024d, limit: 1024 * 1024 * 1024d))),
            [Event(T0 - 10 * Minute + 12_345, ActivityKind.CpuHigh, "a", "app-a CPU high: 50 % of WSL (3 samples ≥ 50 %)", new JsonObject())]);
        var stats = temp.Store.Stats("1h", T0, capacity);

        return Report.Markdown("1h", stats, temp.Store.Events(stats.From, stats.To), DateTimeOffset.FromUnixTimeMilliseconds(T0), TimeZoneInfo.Utc);
    }

    [Fact]
    public void Export_lists_peaks_in_both_sizes_containers_as_a_share_of_wsl_and_one_line_per_event()
    {
        var report = Export(Sizes);

        Assert.StartsWith("# Watcher report: last 1h", report);
        Assert.Contains("- Source: wslc containers watched by Watcher. CPU is a share of WSL's 16 processors (Windows has 32). Memory percentages are of WSL's 45.9 GiB (Windows has 93.7 GiB).\n", report.ReplaceLineEndings("\n"));
        Assert.Contains("| Uptime (share of watched time running) | Restarts |", report);
        Assert.Contains("- Range: 2027-01-15 07:00:00 to 2027-01-15 08:00:00 (local time, UTC+00:00)", report);
        Assert.Contains("- Peak total CPU: 50 % of WSL (25 % of Windows) at 2027-01-15 07:50:00", report);
        Assert.Contains("- Peak total memory: 512 MiB, 1.1 % of WSL (0.5 % of Windows) at 2027-01-15 07:50:00", report);
        Assert.Contains("| app-a (a) | 1 | 50 % | 50 % | 50 % | 512 MiB | 512 MiB | 1.0 GiB | 0 B | 0 B | 0 B | 0 B | 100 % | 0 |", report);
        Assert.Contains("```text\n2027-01-15 07:50:12  cpu-high  app-a  app-a CPU high: 50 % of WSL (3 samples ≥ 50 %)\n```", report.ReplaceLineEndings("\n"));
    }

    [Fact]
    public void Export_before_wsl_is_measured_names_only_windows()
    {
        var report = Export(Capacities.Unmeasured(Sizes.Windows));

        Assert.Contains("- Source: wslc containers watched by Watcher. WSL's size was not measured yet, so CPU is a share of Windows' 32 processors and memory percentages are of Windows' 93.7 GiB.\n", report.ReplaceLineEndings("\n"));
        Assert.Contains("- Peak total CPU: 25 % of Windows at 2027-01-15 07:50:00", report);
        Assert.Contains("- Peak total memory: 512 MiB, 0.5 % of Windows at 2027-01-15 07:50:00", report);
        Assert.Contains("| app-a (a) | 1 | 25 % | 25 % | 25 % | 512 MiB |", report);
    }
}
