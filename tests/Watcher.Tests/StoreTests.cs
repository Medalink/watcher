using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using static Watcher.Tests.Build;

namespace Watcher.Tests;

public sealed class StoreTests : IDisposable
{
    private readonly TempStore _temp = new();
    private Store Store => _temp.Store;

    public void Dispose() => _temp.Dispose();

    private List<object[]> Rows(string sql)
    {
        using var db = new SqliteConnection($"Data Source={_temp.Path};Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = sql;
        using var reader = command.ExecuteReader();
        var rows = new List<object[]>();
        while (reader.Read())
        {
            var row = new object[reader.FieldCount];
            reader.GetValues(row);
            rows.Add(row);
        }

        return rows;
    }

    [Fact]
    public void A_new_database_starts_at_version_3()
    {
        Assert.Equal(new object[] { 3L }, Assert.Single(Rows("PRAGMA user_version")));
    }

    [Fact]
    public void Opening_a_version_1_database_turns_percent_per_core_into_cores()
    {
        Store.Write(Snapshot(T0, (Info("a"), Sample(cpu: 554))), []);
        Rows("PRAGMA user_version = 1");

        using (new Store(_temp.Path, processors: 16))
        {
        }

        Assert.Equal(new object[] { 5.54 }, Assert.Single(Rows("SELECT cpu FROM samples")));
        Assert.Equal(new object[] { 5.54, 5.54 }, Assert.Single(Rows("SELECT cpu_sum, cpu_max FROM minutes")));
        Assert.Equal(new object[] { 3L }, Assert.Single(Rows("PRAGMA user_version")));
    }

    [Fact]
    public void Opening_a_version_2_database_turns_a_share_of_the_host_into_cores()
    {
        var a = Info("a");
        Store.Write(Snapshot(T0, (a, Sample(cpu: 25))), []);
        Store.Write(Snapshot(T0 + 2 * Second, (a, Sample(cpu: 50))), []);
        Rows("PRAGMA user_version = 2");

        using (new Store(_temp.Path, processors: 16))
        {
        }

        Assert.Equal([[4d], [8d]], Rows("SELECT cpu FROM samples ORDER BY at"));
        Assert.Equal(new object[] { 12d, 8d }, Assert.Single(Rows("SELECT cpu_sum, cpu_max FROM minutes")));
        Assert.Equal(new object[] { 3L }, Assert.Single(Rows("PRAGMA user_version")));
    }

    [Fact]
    public void Reopening_a_version_3_database_leaves_cpu_alone()
    {
        Store.Write(Snapshot(T0, (Info("a"), Sample(cpu: 5.54))), []);

        using (new Store(_temp.Path, processors: 16))
        {
        }

        Assert.Equal(new object[] { 5.54 }, Assert.Single(Rows("SELECT cpu FROM samples")));
    }

    [Fact]
    public void Counters_that_go_down_count_as_a_restart_not_a_negative_delta()
    {
        var a = Info("a");
        Store.Write(Snapshot(T0, (a, Sample(netIn: 100, netOut: 10, diskRead: 1_000, diskWrite: 500))), []);
        Store.Write(Snapshot(T0 + 2 * Second, (a, Sample(netIn: 150, netOut: 25, diskRead: 1_400, diskWrite: 500))), []);
        Store.Write(Snapshot(T0 + 4 * Second, (a, Sample(netIn: 30, netOut: 5, diskRead: 100, diskWrite: 50))), []);
        Store.Write(Snapshot(T0 + 6 * Second, (a, Sample(netIn: 50, netOut: 6, diskRead: 160, diskWrite: 80))), []);

        var row = Assert.Single(Rows("SELECT net_in, net_out, disk_read, disk_write FROM minutes"));

        Assert.Equal(new object[] { 70d, 16d, 460d, 30d }, row);
    }

    [Fact]
    public void Minute_rollup_sums_and_maxes_each_minute()
    {
        var a = Info("a");
        Store.Write(Snapshot(T0 + 10 * Second, (a, Sample(cpu: 1, memory: 100))), []);
        Store.Write(Snapshot(T0 + 20 * Second, (a, Sample(cpu: 3, memory: 300))), []);
        Store.Write(Snapshot(T0 + 59 * Second, (a, Sample(cpu: 2, memory: 200))), []);
        Store.Write(Snapshot(T0 + 61 * Second, (a, Sample(cpu: 0.5, memory: 50, limit: 2_000))), []);

        var rows = Rows("SELECT minute, n, cpu_sum, cpu_max, mem_sum, mem_max, mem_limit FROM minutes ORDER BY minute");

        Assert.Equal(
            [
                [T0, 3L, 6d, 3d, 600d, 300d, 1_000d],
                [T0 + Minute, 1L, 0.5, 0.5, 50d, 50d, 2_000d],
            ],
            rows);
    }

    [Fact]
    public void Stats_averages_maxes_uptime_and_restarts_over_hand_built_data()
    {
        var (a, b) = (Info("a"), Info("b"));
        var start = T0 - 30 * Minute;
        Store.Write(Snapshot(start, (a, Sample(cpu: 1, memory: 100)), (b, Sample(cpu: 0.5, memory: 40))), []);
        Store.Write(Snapshot(start + 2 * Second, (a, Sample(cpu: 2, memory: 200)), (b, Sample(cpu: 1.5, memory: 60))), []);
        Store.Write(Snapshot(start + 4 * Second, (a, Sample(cpu: 3, memory: 300)), (b with { State = "exited" }, null)), []);
        Store.Write(Snapshot(start + 2 * Minute, (a, Sample(cpu: 6, memory: 400))),
            [Event(start + 2 * Minute, ActivityKind.State, "a", "app-a exited → running", new JsonObject { ["from"] = "exited", ["to"] = "running" })]);

        var stats = Store.Stats("1h", T0, Sizes);

        Assert.Equal((T0 - Hour, T0, 15_000L), (stats.From, stats.To, stats.BucketMs));
        Assert.Equal(
            [
                new SeriesPoint(start, Cpu: 2 + 1, Memory: 200 + 50, Running: 2),
                new SeriesPoint(start + 2 * Minute, Cpu: 6, Memory: 400, Running: 1),
            ],
            stats.Series);
        Assert.Equal(new Peaks(6, start + 2 * Minute, 400, start + 2 * Minute), stats.Peaks);
        Assert.Equal(
            [
                new ContainerStats("a", "app-a", Samples: 4, CpuAvg: 3, CpuP95: 6, CpuMax: 6, MemAvg: 250, MemMax: 400, MemLimit: 1_000,
                    0, 0, 0, 0, UptimePct: 100, Restarts: 1),
                new ContainerStats("b", "app-b", Samples: 2, CpuAvg: 1, CpuP95: 1, CpuMax: 1.5, MemAvg: 50, MemMax: 60, MemLimit: 1_000,
                    0, 0, 0, 0, UptimePct: 50, Restarts: 0),
            ],
            stats.Containers);
        Assert.Equal(new Dictionary<string, long> { ["state"] = 1 }, stats.Events);
        Assert.Equal((6L, 3L, 1L), (stats.Db.Samples, stats.Db.Minutes, stats.Db.Events));
        Assert.Same(Sizes, stats.Capacity);
    }

    [Fact]
    public void Day_ranges_read_minute_rollups_into_wider_buckets()
    {
        var a = Info("a");
        Store.Write(Snapshot(T0 - 10 * Minute, (a, Sample(cpu: 1, memory: 100))), []);
        Store.Write(Snapshot(T0 - 9 * Minute, (a, Sample(cpu: 3, memory: 300))), []);

        var stats = Store.Stats("24h", T0, Sizes);

        Assert.Equal(300_000L, stats.BucketMs);
        Assert.Equal([new SeriesPoint(T0 - 10 * Minute, Cpu: 2, Memory: 200, Running: 1)], stats.Series);
        Assert.Equal(100, Assert.Single(stats.Containers).UptimePct);
    }

    [Fact]
    public void Uptime_is_the_share_of_watched_minutes_not_of_the_whole_range()
    {
        var a = Info("a");
        for (var minute = 6; minute >= 1; minute--)
        {
            var running = minute > 3;
            Store.Write(Snapshot(T0 - minute * Minute, (a with { State = running ? "running" : "exited" }, running ? Sample(cpu: 1) : null)), []);
        }

        Assert.Equal(50, Assert.Single(Store.Stats("24h", T0, Sizes).Containers).UptimePct);
        Assert.Equal(50, Assert.Single(Store.Stats("1h", T0, Sizes).Containers).UptimePct);
    }

    [Fact]
    public void Stats_on_an_empty_database_serialize_without_NaN()
    {
        var stats = Store.Stats("30d", T0, Sizes);

        Assert.Empty(stats.Series);
        Assert.Empty(stats.Containers);
        Assert.Equal(new Peaks(0, null, 0, null), stats.Peaks);
        Assert.Null(stats.Db.OldestAt);
        Assert.Contains("\"peaks\":{\"cpu\":0,\"cpuAt\":null", JsonSerializer.Serialize(stats, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }

    [Fact]
    public void Activity_pages_newest_first_with_before_and_filters()
    {
        var ids = new[]
        {
            Store.Record(Event(T0, ActivityKind.MonitorStarted, summary: "Monitor started")),
            Store.Record(Event(T0 + 1, ActivityKind.CpuHigh, "a", "app-a CPU high: 55 % of WSL")),
            Store.Record(Event(T0 + 2, ActivityKind.State, "b", "app-b running → exited")),
            Store.Record(Event(T0 + 3, ActivityKind.CpuNormal, "a", "app-a CPU normal: 12 % of WSL")),
            Store.Record(Event(T0 + 4, ActivityKind.Action, "b", "Stopped app-b", new JsonObject { ["output"] = "permission denied" })),
        }.Select(e => e.Id).ToArray();

        var first = Store.Activity(new ActivityQuery(Limit: 2));
        var second = Store.Activity(new ActivityQuery(Before: first.Events[^1].Id, Limit: 2));
        var last = Store.Activity(new ActivityQuery(Before: second.Events[^1].Id, Limit: 2));

        Assert.Equal([ids[4], ids[3]], first.Events.Select(e => e.Id));
        Assert.Equal([ids[2], ids[1]], second.Events.Select(e => e.Id));
        Assert.Equal([ids[0]], last.Events.Select(e => e.Id));
        Assert.Equal((true, true, false), (first.More, second.More, last.More));

        long[] Ids(ActivityQuery query) => Store.Activity(query).Events.Select(e => e.Id).ToArray();
        Assert.Equal([ids[3], ids[1]], Ids(new ActivityQuery(Container: "a")));
        Assert.Equal([ids[3], ids[1]], Ids(new ActivityQuery(Kinds: [ActivityKind.CpuHigh, ActivityKind.CpuNormal])));
        Assert.Empty(Ids(new ActivityQuery(Kinds: [])));
        Assert.Equal([ids[1]], Ids(new ActivityQuery(Before: ids[3], Container: "a")));
        Assert.Equal([ids[4]], Ids(new ActivityQuery(Search: "PERMISSION")));
        Assert.Equal([ids[2]], Ids(new ActivityQuery(Container: "b", Kinds: [ActivityKind.State], Search: "exited")));
    }

    [Fact]
    public void Raw_samples_are_pruned_after_72_hours_at_most_once_an_hour()
    {
        var a = Info("a");
        Store.Write(Snapshot(T0, (a, Sample(cpu: 1))), []);
        Store.Write(Snapshot(T0 + 30 * Minute, (a, Sample(cpu: 2))), []);

        Store.Write(Snapshot(T0 + 72 * Hour + 10 * Minute, (a, Sample(cpu: 3))), []);
        var afterFirstPrune = Rows("SELECT cpu FROM samples ORDER BY at").Select(r => r[0]).ToArray();
        Store.Write(Snapshot(T0 + 72 * Hour + 40 * Minute, (a, Sample(cpu: 4))), []);
        var withinTheHour = Rows("SELECT cpu FROM samples ORDER BY at").Select(r => r[0]).ToArray();
        Store.Write(Snapshot(T0 + 73 * Hour + 15 * Minute, (a, Sample(cpu: 5))), []);
        var afterSecondPrune = Rows("SELECT cpu FROM samples ORDER BY at").Select(r => r[0]).ToArray();

        Assert.Equal([2d, 3d], afterFirstPrune);
        Assert.Equal([2d, 3d, 4d], withinTheHour);
        Assert.Equal([3d, 4d, 5d], afterSecondPrune);
        Assert.Equal(5L, Store.Stats("30d", T0 + 74 * Hour, Sizes).Db.Minutes);
    }

    [Fact]
    public void Containers_no_longer_listed_are_marked_removed_and_not_reloaded()
    {
        Assert.Null(Store.LoadContainers());

        Store.Write(Snapshot(T0, (Info("a"), Sample()), (Info("b", "exited", port: "25435"), null)), [Event(T0, ActivityKind.MonitorStarted)]);
        Store.Write(Snapshot(T0 + 2 * Second, (Info("b", "exited", port: "25435"), null)), []);

        var loaded = Store.LoadContainers();

        Assert.Equal(["b"], loaded!.Keys);
        Assert.Equal(Info("b", "exited", port: "25435"), loaded["b"]);
        Assert.Equal([["a", "removed"], ["b", "exited"]], Rows("SELECT name, state FROM containers ORDER BY name"));
    }

    [Fact]
    public void Removed_containers_list_newest_first_with_how_each_was_removed()
    {
        var tracker = new ActivityTracker(null);
        void Seen(string name, long at) => Store.Write(Snapshot(at, (Info(name), null)), []);
        void Gone(string name, long at) => Store.Record(Event(at, ActivityKind.Disappeared, name));
        void Removing(string name, long at, string source = "row", bool ok = true) =>
            Store.Record(tracker.Action(at, new ContainerRequest(name, "remove", source), ok, "", 900));

        Seen("reaped", T0);
        Removing("reaped", T0 + 10 * Minute, source: "reap");
        Gone("reaped", T0 + 10 * Minute + 3 * Second);
        Seen("row", T0 + Minute);
        Removing("row", T0 + 20 * Minute);
        Gone("row", T0 + 20 * Minute + 2 * Second);
        Seen("late", T0 + 2 * Minute);
        Gone("late", T0 + 25 * Minute);
        Removing("late", T0 + 25 * Minute + 4 * Second);
        Seen("failed", T0 + 3 * Minute);
        Removing("failed", T0 + 30 * Minute, ok: false);
        Gone("failed", T0 + 31 * Minute);
        Seen("stale", T0 + 4 * Minute);
        Removing("stale", T0 + 40 * Minute);
        Gone("stale", T0 + 46 * Minute);
        Seen("silent", T0 + 5 * Minute);
        Store.Write(Snapshot(T0 + Hour, (Info("live"), null)), []);

        var page = Store.RemovedContainers(new RemovedQuery());

        Assert.Equal(6, page.Total);
        Assert.Equal(
            [
                ("stale", T0 + 46 * Minute, Removal.Outside),
                ("failed", T0 + 31 * Minute, Removal.Outside),
                ("late", T0 + 25 * Minute, Removal.Watcher),
                ("row", T0 + 20 * Minute + 2 * Second, Removal.Watcher),
                ("reaped", T0 + 10 * Minute + 3 * Second, Removal.Reap),
                ("silent", T0 + 5 * Minute, Removal.Outside),
            ],
            page.Items.Select(c => (c.Name, c.RemovedAt, c.RemovedBy)));
        Assert.Equal(
            new RemovedContainer("reaped", "app-reaped", "C:/src/shop/app-reaped", null, "nginx:1.27", "",
                FirstSeen: T0, RemovedAt: T0 + 10 * Minute + 3 * Second, Removal.Reap, WasOrphan: false, HasFolder: false,
                PeakMemory: null, AvgCpuCores: null),
            page.Items[4]);
    }

    [Fact]
    public void Removed_containers_carry_lifetime_peak_memory_average_cpu_orphan_and_folder()
    {
        var a = Info("a");
        var b = Info("b") with { Path = System.IO.Path.GetTempPath() };
        Store.Write(Snapshot(T0, (a, Sample(cpu: 1, memory: 100)), (b, null)), []);
        Store.Write(Snapshot(T0 + 20 * Second, (a, Sample(cpu: 3, memory: 300))), []);
        Store.Write(Snapshot(T0 + 5 * Minute, (a with { Orphan = true }, Sample(cpu: 2, memory: 200))), []);
        Store.Write(Snapshot(T0 + 6 * Minute), []);

        var page = Store.RemovedContainers(new RemovedQuery());

        Assert.Equal(
            [
                new RemovedContainer("a", "app-a", "C:/src/shop/app-a", null, "nginx:1.27", "",
                    FirstSeen: T0, RemovedAt: T0 + 5 * Minute, Removal.Outside, WasOrphan: true, HasFolder: false, PeakMemory: 300, AvgCpuCores: 2),
                new RemovedContainer("b", "app-b", System.IO.Path.GetTempPath(), null, "nginx:1.27", "",
                    FirstSeen: T0, RemovedAt: T0, Removal.Outside, WasOrphan: false, HasFolder: true, PeakMemory: null, AvgCpuCores: null),
            ],
            page.Items);
    }

    [Fact]
    public void Removed_containers_page_ten_at_a_time()
    {
        for (var i = 0; i < 23; i++)
        {
            Store.Write(Snapshot(T0 + i * Minute, (Info($"c{i:00}"), null)), []);
            Store.Record(Event(T0 + i * Minute + Second, ActivityKind.Disappeared, $"c{i:00}"));
        }
        Store.Write(Snapshot(T0 + Hour, (Info("live"), null)), []);

        var second = Store.RemovedContainers(new RemovedQuery(Offset: 10, Limit: 10));
        var last = Store.RemovedContainers(new RemovedQuery(Offset: 20, Limit: 10));
        var count = Store.RemovedContainers(new RemovedQuery(Limit: 0));

        Assert.Equal(23, second.Total);
        Assert.Equal(["c12", "c11", "c10", "c09", "c08", "c07", "c06", "c05", "c04", "c03"], second.Items.Select(c => c.Name));
        Assert.Equal(23, last.Total);
        Assert.Equal(["c02", "c01", "c00"], last.Items.Select(c => c.Name));
        Assert.Equal((23L, 0), (count.Total, count.Items.Count));
    }

    [Fact]
    public void History_preloads_the_newest_samples_of_running_containers()
    {
        var (a, b) = (Info("a"), Info("b"));
        for (var i = 0; i < 5; i++)
        {
            Store.Write(Snapshot(T0 + i * 2 * Second, (a, Sample(cpu: i, memory: i * 100)), (b, Sample(cpu: 50))), []);
        }
        Store.Write(Snapshot(T0 + 10 * Second, (a, Sample(cpu: 5, memory: 500)), (b with { State = "exited" }, null)), []);

        var history = Store.LoadHistory(since: T0 + 2 * Second, count: 3);

        Assert.Equal(["a"], history.Keys);
        Assert.Equal([3d, 4d, 5d], history["a"].Cpu);
        Assert.Equal([30d, 40d, 50d], history["a"].Memory);
    }

    [Fact]
    public void Written_events_come_back_with_id_and_container_title()
    {
        var stored = Store.Write(Snapshot(T0, (Info("a"), Sample())),
            [Event(T0, ActivityKind.Appeared, "a", "app-a appeared", new JsonObject { ["state"] = "running" })]);

        var e = Assert.Single(stored);
        Assert.Equal((ActivityKind.Appeared, "a", "app-a", "app-a appeared", "{\"state\":\"running\"}"),
            (e.Kind, e.Container, e.Title, e.Summary, e.Detail!.ToJsonString()));
    }
}
