using System.IO;
using System.Text.Json;
using static Watcher.Tests.Build;

namespace Watcher.Tests;

public sealed class ControlsTests
{
    private sealed class AbandonedContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state) { }
    }

    [Fact]
    public async Task Cancelling_stops_an_owned_process_even_when_the_callers_context_no_longer_pumps()
    {
        var path = Path.Combine(Path.GetTempPath(), "watcher-process-" + Guid.NewGuid().ToString("N"));
        using var cancel = new CancellationTokenSource();
        var runner = new CommandRunner(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
        var previous = SynchronizationContext.Current;
        Task<CommandResult> command;
        try
        {
            SynchronizationContext.SetSynchronizationContext(new AbandonedContext());
            command = runner.RunAsync(["-NoProfile", "-NonInteractive", "-Command", $"[IO.File]::WriteAllText('{path}', [string]$PID); Start-Sleep -Seconds 30"], cancel.Token);
        }
        finally { SynchronizationContext.SetSynchronizationContext(previous); }
        try
        {
            var until = DateTime.UtcNow.AddSeconds(10);
            while (!File.Exists(path) && DateTime.UtcNow < until) await Task.Delay(25);
            Assert.True(File.Exists(path), "Owned child did not become ready.");
            var pid = int.Parse(await File.ReadAllTextAsync(path));
            using var child = System.Diagnostics.Process.GetProcessById(pid);
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => command.WaitAsync(TimeSpan.FromSeconds(10)));
            Assert.True(child.HasExited);
        }
        finally { cancel.Cancel(); File.Delete(path); }
    }

    [Fact]
    public void Unreadable_or_invalid_existing_preferences_never_select_the_default_session()
    {
        var folder = Path.Combine(Path.GetTempPath(), "watcher-preferences-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "preferences.json");
        try
        {
            Assert.Equal("", Preferences.Load(path).Session);
            File.WriteAllText(path, "{broken");
            Assert.Contains("No WSLc session was selected", Assert.Throws<InvalidOperationException>(() => Preferences.Load(path)).Message);
            File.WriteAllText(path, "null");
            Assert.Throws<InvalidOperationException>(() => Preferences.Load(path));
            File.WriteAllText(path, "{\"session\":\"42\"}");
            Assert.Equal("42", Preferences.Load(path).Session);
            using var locked = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            Assert.Throws<InvalidOperationException>(() => Preferences.Load(path));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Fact]
    public void Notification_changes_and_muting_keep_alert_history_and_existing_threshold_state()
    {
        var tracker = new ActivityTracker(null);
        var preferences = new Preferences(Alerts: new AlertPreferences(Samples: 1));
        tracker.Configure(preferences);
        Assert.Single(tracker.Observe(Snapshot(T0, (Info("a"), Sample(cpu: 12))), 16), e => e.Kind == ActivityKind.CpuHigh);
        tracker.Configure(preferences with { KeepRunning = true, Alerts = preferences.EffectiveAlerts with { Muted = true } });
        Assert.DoesNotContain(tracker.Observe(Snapshot(T0 + 1000, (Info("a"), Sample(cpu: 12))), 16), e => e.Kind == ActivityKind.CpuHigh);
        Assert.Single(tracker.Observe(Snapshot(T0 + 2000, (Info("a"), Sample(cpu: 1))), 16), e => e.Kind == ActivityKind.CpuNormal);
        Assert.Single(tracker.Observe(Snapshot(T0 + 3000, (Info("a"), Sample(cpu: 12))), 16), e => e.Kind == ActivityKind.CpuHigh);
    }

    [Fact]
    public void Audit_targets_distinguish_objects_from_containers_and_keep_failure_details()
    {
        using var p = JsonDocument.Parse("""{"kind":"volume","name":"web","path":"C:\\backups\\web","overwrite":true}""");
        var rejected = ManagementAudit.Event(T0, "object-remove", p.RootElement, "42", new ArgumentException("In use."));
        Assert.Null(rejected.Container);
        Assert.Equal("volume", rejected.Detail!["kind"]!.ToString());
        Assert.Equal("rejected", rejected.Detail["outcome"]!.ToString());
        Assert.Equal("42", rejected.Detail["session"]!.ToString());
        var error = new OperationCanceledException("A partial copy may remain.");
        error.Data["partialOutput"] = @"C:\backups\web";
        var cancelled = ManagementAudit.Event(T0, "volume-backup", p.RootElement, "", error);
        Assert.Equal("cancelled", cancelled.Detail!["outcome"]!.ToString());
        Assert.Equal(@"C:\backups\web", cancelled.Detail["partialOutput"]!.ToString());
        Assert.True(cancelled.Detail["overwrite"]!.GetValue<bool>());
        var interrupted = ManagementAudit.Interrupted(T0, "volume-backup", p.RootElement, "42");
        Assert.Equal("interrupted", interrupted.Detail!["outcome"]!.ToString());
        Assert.Equal(@"C:\backups\web", interrupted.Detail["possiblePartialOutput"]!.ToString());
        Assert.Contains("outcome unknown", interrupted.Summary);
        using var upload = JsonDocument.Parse("""{"name":"web","direction":"in","hostPath":"C:\\source.txt","containerPath":"/data/"}""");
        Assert.Equal("web:/data/", ManagementAudit.Interrupted(T0, "copy", upload.RootElement, "").Detail!["possiblePartialOutput"]!.ToString());
    }

    [Fact]
    public void Inspection_masks_separate_secret_arguments_and_preserves_native_event_time()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse("""{"Cmd":["app","--password","hidden","--port","80","--token=secret"]}""")!;
        var text = Inspection.Masked(node)!.ToJsonString();
        Assert.DoesNotContain("hidden", text);
        Assert.DoesNotContain("secret", text);
        Assert.Contains("80", text);
        using var entry = JsonDocument.Parse("""{"timeNano":1792181000123456789}""");
        Assert.Equal(1792181000123L, Inspection.EventTime(entry.RootElement, T0));
    }

    [Fact]
    public void Stop_and_restart_use_their_actual_cli_timeout_options()
    {
        Assert.Equal(["stop", "--time", "12", "database"], ControlCommands.Lifecycle("database", "stop", 12));
        Assert.Equal(["restart", "--timeout", "12", "database"], ControlCommands.Lifecycle("database", "restart", 12));
        Assert.Equal(["start", "database"], ControlCommands.Lifecycle("database", "start", 12));
    }

    [Theory]
    [InlineData("--all", "stop", 10)]
    [InlineData("", "start", 10)]
    [InlineData("database", "create", 10)]
    [InlineData("database", "stop", 0)]
    [InlineData("database", "stop", 121)]
    [InlineData("one;two", "stop", 10)]
    [InlineData("one two", "stop", 10)]
    public void Invalid_control_requests_do_not_produce_commands(string name, string operation, int timeout) =>
        Assert.Throws<ArgumentException>(() => ControlCommands.Lifecycle(name, operation, timeout));

    [Fact]
    public void Every_argument_and_session_stays_a_separate_argument()
    {
        var runner = new CommandRunner("wslc.exe", "42");
        var info = runner.StartInfo(["container", "cp", "web:/tmp/file with spaces", @"C:\output folder\a;literal.txt"]);
        Assert.Equal(["--session", "42", "container", "cp", "web:/tmp/file with spaces", @"C:\output folder\a;literal.txt"], info.ArgumentList);
        Assert.False(info.UseShellExecute);
        Assert.True(info.CreateNoWindow);
    }

    [Fact]
    public async Task An_actual_child_process_is_stopped_when_its_deadline_expires()
    {
        var runner = new CommandRunner(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        await Assert.ThrowsAsync<TimeoutException>(() => runner.RunAsync(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], timeout: TimeSpan.FromMilliseconds(500)));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), "The owned process must be killed before its 30 second sleep finishes.");
    }

    [Fact]
    public async Task Cancellation_remains_distinct_from_a_deadline()
    {
        var runner = new CommandRunner(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runner.RunAsync(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], cancel.Token));
    }

    [Fact]
    public void Custom_alerts_keep_recovery_and_sustained_sample_behavior()
    {
        var tracker = new ActivityTracker(null);
        tracker.Configure(new Preferences(Alerts: new AlertPreferences(CpuHigh: 75, CpuRecovery: 50, Samples: 2)));
        var first = tracker.Observe(Snapshot(T0, (Info("a"), Sample(cpu: 12))), 16);
        var second = tracker.Observe(Snapshot(T0 + 1000, (Info("a"), Sample(cpu: 12))), 16);
        var third = tracker.Observe(Snapshot(T0 + 2000, (Info("a"), Sample(cpu: 7))), 16);
        var fourth = tracker.Observe(Snapshot(T0 + 3000, (Info("a"), Sample(cpu: 7))), 16);
        Assert.DoesNotContain(first, e => e.Kind == ActivityKind.CpuHigh);
        Assert.Equal("app-a CPU high: 75 % of WSL (2 samples ≥ 75 %)", Assert.Single(second, e => e.Kind == ActivityKind.CpuHigh).Summary);
        Assert.DoesNotContain(third, e => e.Kind == ActivityKind.CpuNormal);
        Assert.Single(fourth, e => e.Kind == ActivityKind.CpuNormal);
    }

    [Fact]
    public void A_container_override_does_not_change_another_containers_alert()
    {
        var tracker = new ActivityTracker(null);
        tracker.Configure(new Preferences(ContainerAlerts: new Dictionary<string, AlertPreferences> { ["a"] = new(CpuHigh: 90, Samples: 1) }));
        var snapshot = Snapshot(T0, (Info("a"), Sample(cpu: 8)), (Info("b"), Sample(cpu: 8)));
        tracker.Observe(snapshot, 16);
        tracker.Observe(snapshot with { At = T0 + 1000 }, 16);
        var events = tracker.Observe(snapshot with { At = T0 + 2000 }, 16);
        Assert.Equal("b", Assert.Single(events, e => e.Kind == ActivityKind.CpuHigh).Container);
    }

    [Fact]
    public void Invalid_preferences_are_rejected_and_session_paths_do_not_escape_the_data_root()
    {
        Assert.Throws<ArgumentException>(() => new Preferences(Alerts: new AlertPreferences(CpuRecovery: 80)).Validated());
        Assert.Throws<ArgumentException>(() => new Preferences(Alerts: new AlertPreferences(MemoryHigh: double.NaN)).Validated());
        Assert.Throws<ArgumentException>(() => new Preferences(Alerts: new AlertPreferences(Samples: 0)).Validated());
        Assert.Equal(Preferences.Root, Preferences.SessionFolder(""));
        Assert.StartsWith(Path.Combine(Preferences.Root, "sessions"), Preferences.SessionFolder("../../a"));
        Assert.NotEqual(Preferences.SessionFolder("1"), Preferences.SessionFolder("2"));
    }

    [Fact]
    public void Terminal_arguments_keep_the_target_user_workdir_and_shell_separate()
    {
        Assert.Equal(["--session", "42", "exec", "--interactive", "--tty", "--user", "1000:1000", "--workdir", "/app with spaces", "web", "/bin/bash"],
            ControlCommands.Terminal("web", "42", "1000:1000", "/app with spaces", "/bin/bash"));
        Assert.Throws<ArgumentException>(() => ControlCommands.Terminal("web", "", "", "/app;new-tab", "/bin/sh"));
        Assert.Throws<ArgumentException>(() => ControlCommands.Terminal("web", "", "", "relative", "/bin/sh"));
    }

    [Fact]
    public void Session_termination_requires_confirmation_and_the_actual_active_target()
    {
        Assert.Throws<ArgumentException>(() => ControlCommands.TerminateSession("42", "7", true));
        Assert.Throws<ArgumentException>(() => ControlCommands.TerminateSession("42", "42", false));
        Assert.Equal(["system", "session", "terminate"], ControlCommands.TerminateSession("42", "42", true));
        Assert.Equal(["system", "session", "terminate"], ControlCommands.TerminateSession("", "default", true));
    }
}
