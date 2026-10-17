using static Watcher.Tests.Build;

namespace Watcher.Tests;

public sealed class ActivityTests
{
    private static Dictionary<string, ContainerInfo> State(params ContainerInfo[] containers) => containers.ToDictionary(c => c.Name);

    private static (string Kind, string? Container, string Summary, string? Detail)[] Shape(IEnumerable<ActivityEvent> events) =>
        events.Select(e => (e.Kind, e.Container, e.Summary, e.Detail?.ToJsonString())).ToArray();

    [Fact]
    public void Diff_reports_appeared_and_disappeared_containers()
    {
        var events = Activity.Diff(State(Info("old", "exited")), State(Info("new")), T0);

        Assert.Equal(
            [
                (ActivityKind.Appeared, "new", "app-new appeared (running, nginx:1.27)",
                    """{"state":"running","image":"nginx:1.27","path":"C:/src/shop/app-new","port":""}"""),
                (ActivityKind.Disappeared, "old", "app-old disappeared (was exited)", """{"lastState":"exited"}"""),
            ],
            Shape(events));
        Assert.All(events, e => Assert.Equal(T0, e.At));
    }

    [Fact]
    public void Diff_reports_state_orphan_and_port_changes()
    {
        var events = Activity.Diff(
            State(Info("a"), Info("b"), Info("c", port: "25435")),
            State(Info("a", "exited"), Info("b", orphan: true), Info("c", port: "25436")),
            T0);

        Assert.Equal(
            [
                (ActivityKind.State, "a", "app-a running → exited", """{"from":"running","to":"exited"}"""),
                (ActivityKind.Orphaned, "b", "app-b orphaned: folder C:/src/shop/app-b was deleted",
                    """{"path":"C:/src/shop/app-b"}"""),
                (ActivityKind.Port, "c", "app-c port 25435 → 25436", """{"from":"25435","to":"25436"}"""),
            ],
            Shape(events));
    }

    [Fact]
    public void Diff_is_empty_when_nothing_changed_and_orphans_are_reported_once()
    {
        Assert.Empty(Activity.Diff(State(Info("a", orphan: true)), State(Info("a", orphan: true)), T0));
        Assert.Equal("app-a port 25435 → none", Assert.Single(Activity.Diff(State(Info("a", port: "25435")), State(Info("a")), T0)).Summary);
    }

    [Fact]
    public void Diff_against_the_persisted_state_is_marked_while_closed()
    {
        var events = Activity.Diff(State(Info("a"), Info("gone")), State(Info("a", "exited")), T0, whileClosed: true);

        Assert.Equal(
            [
                (ActivityKind.State, "a", "app-a running → exited while the monitor was closed",
                    """{"from":"running","to":"exited","whileClosed":true}"""),
                (ActivityKind.Disappeared, "gone", "app-gone disappeared (was running) while the monitor was closed",
                    """{"lastState":"running","whileClosed":true}"""),
            ],
            Shape(events));
    }

    [Fact]
    public void Hysteresis_needs_three_samples_each_way_and_never_repeats()
    {
        var cpu = Activity.Thresholds[0];
        double[] samples = [55, 60, 65, 70, 70, 70, 20, 20, 30, 20, 20, 20, 55];
        var alert = default(Alert);
        var flips = new List<(int Sample, Level Level)>();
        for (var i = 0; i < samples.Length; i++)
        {
            (alert, var flipped) = Activity.Step(alert, samples[i], cpu);
            if (flipped)
            {
                flips.Add((i, alert.Level));
            }
        }

        Assert.Equal([(2, Level.High), (11, Level.Normal)], flips);
        Assert.Equal(new Alert(Level.Normal, 1), alert);
    }

    [Fact]
    public void Two_samples_above_then_one_below_resets_the_streak()
    {
        var memory = Activity.Thresholds[1];
        var alert = default(Alert);
        foreach (var value in new double[] { 95, 91, 70, 95, 92 })
        {
            (alert, var flipped) = Activity.Step(alert, value, memory);
            Assert.False(flipped);
        }

        Assert.Equal(new Alert(Level.Normal, 2), alert);
    }

    [Fact]
    public void Tracker_logs_cpu_high_as_a_share_of_wsl_once_and_normal_after_three_low_samples()
    {
        var tracker = new ActivityTracker(State());
        var a = Info("a");
        var events = new[] { 2.2, 2.2, 2.2, 2.4, 0.8, 0.8, 0.8 }
            .SelectMany((cores, i) => tracker.Observe(Snapshot(T0 + i * 2 * Second, (a, Sample(cpu: cores))), wslCpus: 4))
            .Where(e => e.Kind != ActivityKind.MonitorStarted && e.Kind != ActivityKind.Appeared);

        Assert.Equal(
            [
                (ActivityKind.CpuHigh, "a", "app-a CPU high: 55 % of WSL (3 samples ≥ 50 %)", """{"value":55,"threshold":50,"samples":3}"""),
                (ActivityKind.CpuNormal, "a", "app-a CPU normal: 20 % of WSL (3 samples < 25 %)", """{"value":20,"threshold":25,"samples":3}"""),
            ],
            Shape(events));
    }

    [Fact]
    public void Two_cores_are_quiet_on_a_large_wsl_and_high_on_a_small_one()
    {
        int HighAlerts(int wslCpus)
        {
            var tracker = new ActivityTracker(State());
            return Enumerable.Range(0, 3)
                .SelectMany(i => tracker.Observe(Snapshot(T0 + i * 2 * Second, (Info("a"), Sample(cpu: 2))), wslCpus))
                .Count(e => e.Kind == ActivityKind.CpuHigh);
        }

        Assert.Equal((0, 1), (HighAlerts(32), HighAlerts(4)));
    }

    [Fact]
    public void Memory_alerts_stay_a_share_of_the_container_limit()
    {
        var tracker = new ActivityTracker(State());
        var events = Enumerable.Range(0, 3)
            .SelectMany(i => tracker.Observe(Snapshot(T0 + i * 2 * Second, (Info("a"), Sample(memory: 950, limit: 1_000))), wslCpus: 4))
            .Where(e => e.Kind == ActivityKind.MemoryHigh);

        Assert.Equal(
            [(ActivityKind.MemoryHigh, "a", "app-a memory high: 95 % (3 samples ≥ 90 % of the limit)", """{"value":95,"threshold":90,"samples":3}""")],
            Shape(events));
    }

    [Fact]
    public void Tracker_on_a_brand_new_database_logs_only_monitor_started()
    {
        var tracker = new ActivityTracker(persisted: null);

        var events = tracker.Observe(Snapshot(T0, (Info("a"), Sample()), (Info("b", "exited"), null)), wslCpus: 4);

        Assert.Equal(
            [
                (ActivityKind.MonitorStarted, null, "Monitor started: 2 containers, 1 running",
                    """{"containers":[{"name":"a","title":"app-a","state":"running","orphan":false},{"name":"b","title":"app-b","state":"exited","orphan":false}]}"""),
            ],
            Shape(events));
    }

    [Fact]
    public void Tracker_diffs_the_first_snapshot_against_the_persisted_state_only()
    {
        var tracker = new ActivityTracker(State(Info("a"), Info("removed")));

        var first = tracker.Observe(Snapshot(T0, (Info("a", "exited"), null)), wslCpus: 4);
        var second = tracker.Observe(Snapshot(T0 + 2 * Second, (Info("a"), Sample())), wslCpus: 4);

        Assert.Equal(
            [
                (ActivityKind.MonitorStarted, "Monitor started: 1 container, 0 running"),
                (ActivityKind.State, "app-a running → exited while the monitor was closed"),
                (ActivityKind.Disappeared, "app-removed disappeared (was running) while the monitor was closed"),
            ],
            first.Select(e => (e.Kind, e.Summary)));
        Assert.Equal([(ActivityKind.State, "app-a exited → running")], second.Select(e => (e.Kind, e.Summary)));
    }

    [Fact]
    public void Tracker_logs_only_wslc_transitions()
    {
        var tracker = new ActivityTracker(State());
        tracker.Observe(Snapshot(T0), wslCpus: 4);

        var offline = tracker.Offline(T0 + 1, "wslc list failed: service stopped").Concat(tracker.Offline(T0 + 2, "again"));
        var online = tracker.Observe(Snapshot(T0 + 3), wslCpus: 4).Concat(tracker.Observe(Snapshot(T0 + 4), wslCpus: 4));

        Assert.Equal(
            [
                (ActivityKind.WslcOffline, null, "wslc is unreachable: wslc list failed: service stopped", """{"message":"wslc list failed: service stopped"}"""),
                (ActivityKind.WslcOnline, null, "wslc is reachable again", null),
            ],
            Shape(offline.Concat(online)));
    }

    [Fact]
    public void Actions_record_outcome_output_and_duration()
    {
        var tracker = new ActivityTracker(State());
        tracker.Observe(Snapshot(T0, (Info("a"), Sample())), wslCpus: 4);

        var ok = tracker.Action(T0, new ContainerRequest("a", "restart"), ok: true, "a\r\n", 1_234);
        var failed = tracker.Action(T0, new ContainerRequest("a", "stop"), ok: false, "  Error: permission denied\nmore\n" + new string('x', 3_000), 87);

        Assert.Equal((ActivityKind.Action, "a", "Restarted app-a (1.2 s)", """{"op":"restart","source":"row","ok":true,"output":"a","ms":1234}"""), Shape([ok])[0]);
        Assert.Equal("wslc stop failed for app-a after 0.1 s: Error: permission denied", failed.Summary);
        Assert.Equal(2_000, failed.Detail!["output"]!.GetValue<string>().Length);
    }
}
