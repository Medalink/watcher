using System.IO;
using static Watcher.Tests.Build;

namespace Watcher.Tests;

public sealed class LimitTests
{
    private const double GiB = 1024d * 1024 * 1024;

    private static LimitEnforcer Enforcer(ResourceLimits limits, Dictionary<string, ResourceLimits>? overrides = null)
    {
        var enforcer = new LimitEnforcer();
        enforcer.Configure(new Preferences(Limits: limits, ContainerLimits: overrides));
        return enforcer;
    }

    private static ContainerInfo Created(string name, long created, string state = "running") => Info(name, state) with { Created = created };

    private static (string, string, string)[] Shape(IEnumerable<Breach> breaches) =>
        breaches.Select(b => (b.Info.Name, b.Rule.Key, b.Operation)).ToArray();

    [Fact]
    public void Memory_breach_fires_once_after_the_required_samples_and_rearms_below_the_limit()
    {
        var enforcer = Enforcer(new ResourceLimits(MemoryGiB: new Limit(2, LimitAction.Stop), Samples: 3));
        var over = Sample(memory: 3 * GiB, limit: 8 * GiB);
        var under = Sample(memory: 1 * GiB, limit: 8 * GiB);
        var fired = new List<int>();
        var samples = new[] { over, over, over, over, under, over, over, over };
        for (var i = 0; i < samples.Length; i++)
        {
            if (enforcer.Evaluate(Snapshot(T0 + i * Second, (Info("a"), samples[i])), 16).Count > 0) fired.Add(i);
        }

        Assert.Equal([2, 7], fired);
    }

    [Fact]
    public void Cpu_is_a_share_of_wsl_and_age_acts_on_the_first_poll()
    {
        var enforcer = Enforcer(new ResourceLimits(CpuPercent: new Limit(50, LimitAction.Log), AgeHours: new Limit(24, LimitAction.Remove), Samples: 1));
        var breaches = enforcer.Evaluate(Snapshot(T0,
            (Created("busy", T0 - Hour), Sample(cpu: 8)),
            (Created("idle", T0 - Hour), Sample(cpu: 7.9)),
            (Created("old", T0 - 25 * Hour, "exited"), null)), wslCpus: 16);

        Assert.Equal([("busy", "cpu", ""), ("old", "age", "remove")], Shape(breaches));
        Assert.Equal("app-old over its age limit: 25 hours ≥ 24 hours; removing it", breaches[1].ToEvent(T0).Summary);
    }

    [Fact]
    public void Stop_skips_containers_that_are_not_running_and_rearms_when_they_start_again()
    {
        var enforcer = Enforcer(new ResourceLimits(AgeHours: new Limit(1, LimitAction.Stop)));
        var created = T0 - 2 * Hour;

        Assert.Single(enforcer.Evaluate(Snapshot(T0, (Created("a", created), Sample())), 16));
        Assert.Empty(enforcer.Evaluate(Snapshot(T0 + Second, (Created("a", created), Sample())), 16));
        Assert.Empty(enforcer.Evaluate(Snapshot(T0 + 2 * Second, (Created("a", created, "exited"), null)), 16));
        Assert.Single(enforcer.Evaluate(Snapshot(T0 + 3 * Second, (Created("a", created), Sample())), 16));
    }

    [Fact]
    public void Saving_unrelated_preferences_keeps_streaks_but_changed_limits_start_over()
    {
        var limits = new ResourceLimits(AgeHours: new Limit(1));
        var enforcer = Enforcer(limits);
        var old = Snapshot(T0, (Created("a", T0 - 2 * Hour, "exited"), null));
        Assert.Single(enforcer.Evaluate(old, 16));

        enforcer.Configure(new Preferences(Alerts: new AlertPreferences(CpuHigh: 60), Limits: limits));
        Assert.Empty(enforcer.Evaluate(old, 16));

        enforcer.Configure(new Preferences(Limits: new ResourceLimits(AgeHours: new Limit(1.5))));
        Assert.Single(enforcer.Evaluate(old, 16));
    }

    [Fact]
    public void Unknown_creation_time_never_counts_as_old()
    {
        var enforcer = Enforcer(new ResourceLimits(AgeHours: new Limit(1, LimitAction.Remove)));

        Assert.Empty(enforcer.Evaluate(Snapshot(T0, (Info("a"), Sample())), 16));
    }

    [Fact]
    public void A_container_override_replaces_the_defaults_and_an_empty_one_exempts_it()
    {
        var enforcer = Enforcer(new ResourceLimits(MemoryGiB: new Limit(1, LimitAction.Remove), Samples: 1),
            new() { ["db"] = new ResourceLimits(), ["web"] = new ResourceLimits(MemoryGiB: new Limit(4, LimitAction.Stop), Samples: 1) });
        var breaches = enforcer.Evaluate(Snapshot(T0,
            (Info("db"), Sample(memory: 5 * GiB, limit: 8 * GiB)),
            (Info("web"), Sample(memory: 5 * GiB, limit: 8 * GiB)),
            (Info("job"), Sample(memory: 2 * GiB, limit: 8 * GiB))), 16);

        Assert.Equal([("web", "memory", "stop"), ("job", "memory", "remove")], Shape(breaches));
    }

    [Theory]
    [InlineData(0, 3)]
    [InlineData(-1, 3)]
    [InlineData(double.NaN, 3)]
    [InlineData(2000, 3)]
    [InlineData(2, 0)]
    public void Validation_rejects_out_of_range_limits(double memory, int samples)
    {
        Assert.Throws<ArgumentException>(() => new Preferences(Limits: new ResourceLimits(MemoryGiB: new Limit(memory), Samples: samples)).Validated());
    }

    [Fact]
    public void Limits_round_trip_through_the_preferences_file_with_named_actions()
    {
        var folder = Directory.CreateTempSubdirectory().FullName;
        try
        {
            var path = Path.Combine(folder, "preferences.json");
            File.WriteAllText(path, """
                {"session":"","limits":{"memoryGiB":{"value":2.5,"action":"stop"},"ageHours":{"value":48,"action":"remove"},"samples":20},
                 "containerLimits":{"db":{}}}
                """);
            var loaded = Preferences.Load(path);

            Assert.Equal(new Limit(2.5, LimitAction.Stop), loaded.Limits!.MemoryGiB);
            Assert.Equal(new Limit(48, LimitAction.Remove), loaded.Limits.AgeHours);
            Assert.Null(loaded.LimitsFor("db").MemoryGiB);
            Assert.Equal(new Limit(2.5, LimitAction.Stop), loaded.LimitsFor("web").MemoryGiB);

            File.WriteAllText(path, """{"session":"old"}""");
            Assert.Equal(new ResourceLimits(), Preferences.Load(path).LimitsFor("web"));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void Removal_by_a_limit_is_listed_as_its_own_kind()
    {
        using var temp = new TempStore();
        temp.Store.Write(Snapshot(T0, (Info("a"), null)), []);
        temp.Store.Record(new ActivityTracker(null).Action(T0 + Minute, new ContainerRequest("a", "remove", Removal.Limit), true, "", 900));
        temp.Store.Record(Event(T0 + Minute + 2 * Second, ActivityKind.Disappeared, "a"));
        temp.Store.Write(Snapshot(T0 + Hour), []);

        Assert.Equal(Removal.Limit, Assert.Single(temp.Store.RemovedContainers(new RemovedQuery()).Items).RemovedBy);
    }
}
