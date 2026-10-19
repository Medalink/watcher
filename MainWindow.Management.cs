using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace Watcher;

public partial class MainWindow
{
    private Preferences _preferences = Preferences.Startup;
    private readonly LimitEnforcer _limits = new();
    private readonly Dictionary<string, CancellationTokenSource> _operations = [];
    private readonly Dictionary<string, (string Operation, JsonElement Parameters)> _actionRequests = [];
    private readonly Dictionary<Guid, ContainerRequest> _lifecycle = [];
    private readonly Dictionary<string, long> _notified = [];
    private Management? _management;
    private Tray? _tray;
    private bool _exit;
    private Snapshot? _latest;
    private bool _eventsRunning;
    private bool _sessionPaused;
    private bool _takingSnapshot;
    private bool _trayRetryStarted;
    private long _nextEvents;
    private long _eventSince = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private string? _eventError;
    private readonly HashSet<string> _eventIds = [];
    private readonly Queue<string> _eventOrder = [];

    private static async Task<bool> SessionActiveAsync(CancellationToken token)
    {
        try
        {
            var result = await Wslc.Client.RunAsync(["system", "info", "--format", "json"], token, TimeSpan.FromSeconds(5));
            using var document = JsonDocument.Parse(result.RequireSuccess());
            var sessions = document.RootElement.GetProperty("Server").GetProperty("Sessions");
            return sessions.EnumerateArray().Any(s => Wslc.Session.Length == 0
                ? s.GetProperty("Name").GetString() == "wslc-cli-" + Environment.UserName
                : s.GetProperty("ID").ToString() == Wslc.Session || s.GetProperty("Name").GetString() == Wslc.Session);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return false;
        }
    }

    private async Task<object?> ManageAsync(JsonElement request)
    {
        var operation = Required(request, "operation");
        var parameters = request.TryGetProperty("parameters", out var value) ? value : JsonSerializer.SerializeToElement(new { });
        if (operation == "cancel-operation")
        {
            var target = Required(parameters, "id");
            if (_operations.TryGetValue(target, out var running)) running.Cancel();
            return new { message = "Cancellation requested." };
        }
        var id = request.TryGetProperty("operationId", out var identifier) ? identifier.GetString() ?? Guid.NewGuid().ToString("N") : Guid.NewGuid().ToString("N");
        if (_operations.ContainsKey(id)) throw new InvalidOperationException("This operation is already running.");
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_closing.Token);
        _operations.Add(id, cancellation);
        if (ManagementAudit.Includes(operation)) _actionRequests.Add(id, (operation, parameters.Clone()));
        Send(new { type = "operation", id, operation, running = true });
        try
        {
            if (_sessionPaused && operation is not ("preferences" or "save-preferences" or "limits" or "save-limits" or "pick-path" or "open-runtime-settings" or "session-resume"))
                throw new InvalidOperationException("Monitoring is paused after a session termination request. Resume monitoring in Manage → Runtime before contacting WSLc again.");
            object? result = operation switch
            {
                "bulk" => await BulkAsync(parameters, cancellation.Token),
                "terminal" => OpenTerminal(parameters),
                "preferences" => PreferenceView(),
                "save-preferences" => SavePreferences(parameters),
                "limits" => LimitsView(),
                "save-limits" => SaveLimits(parameters),
                "open-runtime-settings" => OpenRuntimeSettings(),
                "session-terminate" => await TerminateSessionAsync(parameters, cancellation.Token),
                "session-resume" => ResumeSession(),
                "readiness" => await ReadinessAsync(parameters, cancellation.Token),
                "pick-path" => PickPath(parameters),
                _ => await (_management ??= new Management(Wslc.Client)).HandleAsync(operation, parameters, cancellation.Token),
            };
            if (ManagementAudit.Includes(operation))
            {
                RecordManagement(operation, parameters);
            }
            return result;
        }
        catch (Exception exception)
        {
            if (ManagementAudit.Includes(operation))
            {
                RecordManagement(operation, parameters, exception);
            }
            if (exception is OperationCanceledException) throw new InvalidOperationException(exception.Message + " An action already sent to WSLc may still finish; refresh its state.");
            throw;
        }
        finally
        {
            _operations.Remove(id);
            _actionRequests.Remove(id);
            Send(new { type = "operation", id, operation, running = false });
        }
    }

    private void RecordManagement(string operation, JsonElement parameters, Exception? error = null)
    {
        Persist(() => [_store.Record(ManagementAudit.Event(Now(), operation, parameters, Wslc.Session, error))]);
    }

    private void RecordInterruptedActions()
    {
        foreach (var action in _actionRequests.Values)
            Persist(() => [_store.Record(ManagementAudit.Interrupted(Now(), action.Operation, action.Parameters, Wslc.Session))]);
        foreach (var action in _lifecycle.Values)
        {
            var activity = _activity.Action(Now(), action, false, "Watcher exited during the action. Its outcome is unknown; refresh its state.", 0);
            activity.Detail!["outcome"] = "interrupted";
            Persist(() => [_store.Record(activity)]);
        }
    }

    private object PreferenceView() => new
    {
        _preferences.Session, _preferences.KeepRunning, _preferences.StartAtLogin,
        alerts = _preferences.EffectiveAlerts, containerAlerts = _preferences.ContainerAlerts ?? new Dictionary<string, AlertPreferences>(),
        activeSession = Wslc.Session,
        sessionPaused = _sessionPaused,
    };

    private object SavePreferences(JsonElement parameters)
    {
        var page = parameters.Deserialize<Preferences>(Json) ?? throw new ArgumentException("Preferences are required.");
        // The Resources page owns the limits, so this form never carries them.
        var next = page.Validated() with { Limits = _preferences.Limits, ContainerLimits = _preferences.ContainerLimits };
        if (next.KeepRunning || next.EffectiveAlerts.Notifications) EnsureTray();
        if ((next.KeepRunning || next.EffectiveAlerts.Notifications) && _tray is null) throw new InvalidOperationException("The notification area is unavailable. Background mode was not enabled.");
        next.Save();
        try
        {
            if (next.StartAtLogin != _preferences.StartAtLogin) Tray.RegisterStartup(next.StartAtLogin);
        }
        catch
        {
            _preferences.Save();
            throw;
        }
        Apply(next);
        var restart = !string.Equals(next.Session, Wslc.Session, StringComparison.Ordinal);
        return new { message = restart ? "Saved. Restart Watcher to switch sessions. Current monitoring and actions keep their original target." : "Preferences saved.", restartRequired = restart };
    }

    private sealed record LimitsPage(ResourceLimits? Limits, Dictionary<string, ResourceLimits>? ContainerLimits);

    private object LimitsView() => new
    {
        limits = _preferences.Limits ?? new(), containerLimits = _preferences.ContainerLimits ?? new Dictionary<string, ResourceLimits>(),
    };

    /// <summary>Saves only the limits; everything the Preferences tab owns stays as it is.</summary>
    private object SaveLimits(JsonElement parameters)
    {
        var page = parameters.Deserialize<LimitsPage>(Json) ?? throw new ArgumentException("Limits are required.");
        if (page.ContainerLimits?.Keys.Any(name => !ControlCommands.IsContainerName(name)) == true) throw new ArgumentException("Invalid container name.");
        var next = (_preferences with { Limits = page.Limits, ContainerLimits = page.ContainerLimits }).Validated();
        next.Save();
        Apply(next);
        return new { message = "Limits saved. Watcher enforces them from the next refresh." };
    }

    private void Apply(Preferences next)
    {
        _preferences = next;
        _activity.Configure(next);
        _limits.Configure(next);
    }

    /// <summary>Records each new breach, then sends its stop or remove without holding up the poll loop.</summary>
    private void Enforce(Snapshot snapshot)
    {
        var breaches = _limits.Evaluate(snapshot, _capacity.Wsl.Cpus);
        if (breaches.Count == 0) return;
        Persist(() => breaches.Select(breach => _store.Record(breach.ToEvent(snapshot.At))).ToList());
        foreach (var breach in breaches.Where(b => b.Operation.Length > 0))
        {
            if (_lifecycle.Values.Any(action => action.Name == breach.Info.Name)) continue;
            _ = RunAsync(new ContainerRequest(breach.Info.Name, breach.Operation, Removal.Limit));
        }
    }

    private static string Required(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString())) throw new ArgumentException($"{property} is required.");
        var text = value.GetString()!;
        if (text.Length > 4096 || text.Any(char.IsControl)) throw new ArgumentException($"Invalid {property}.");
        return text;
    }

    private static string ObjectName(JsonElement element, string key = "name")
    {
        var name = Required(element, key);
        if (!ControlCommands.IsContainerName(name)) throw new ArgumentException("Invalid container name.");
        return name;
    }

    private static object OpenTerminal(JsonElement parameters)
    {
        var name = ObjectName(parameters);
        var user = parameters.TryGetProperty("user", out var u) ? u.GetString() ?? "" : "";
        var workdir = parameters.TryGetProperty("workdir", out var w) ? w.GetString() ?? "" : "";
        var shell = parameters.TryGetProperty("shell", out var chosen) && chosen.GetString() is { Length: > 0 } s ? s : "/bin/sh";
        var args = ControlCommands.Terminal(name, Wslc.Session, user, workdir, shell);
        var start = new ProcessStartInfo("wt.exe") { UseShellExecute = true };
        foreach (var arg in new[] { "new-tab", "--title", name, Wslc.Exe ?? throw new InvalidOperationException("wslc is missing.") }.Concat(args)) start.ArgumentList.Add(arg);
        try { Process.Start(start); }
        catch (System.ComponentModel.Win32Exception) { throw new InvalidOperationException("Windows Terminal is required for an interactive shell. Install it and try again."); }
        return new { message = $"Opened a terminal for {name}." };
    }

    private async Task<object> BulkAsync(JsonElement parameters, CancellationToken token)
    {
        if (_sessionPaused) throw new InvalidOperationException("Resume monitoring in Manage → Runtime before sending lifecycle actions.");
        var op = Required(parameters, "op");
        if (op is not ("start" or "stop" or "restart")) throw new ArgumentException("Unsupported lifecycle action.");
        var names = parameters.GetProperty("names").EnumerateArray().Select(v => v.GetString() ?? "").Distinct().ToList();
        if (names.Count is < 1 or > 100 || names.Any(n => !ControlCommands.IsContainerName(n)))
            throw new ArgumentException("Select between 1 and 100 valid container names.");
        var timeout = parameters.TryGetProperty("timeout", out var duration) ? duration.GetInt32() : 10;
        if (timeout is < 1 or > 120) throw new ArgumentException("Stop timeout must be between 1 and 120 seconds.");
        var results = new List<object>();
        foreach (var name in names)
        {
            token.ThrowIfCancellationRequested();
            if (_sessionPaused) throw new OperationCanceledException("Lifecycle actions paused for session termination.", token);
            Send(new { type = "busy", name, busy = true });
            var watch = Stopwatch.StartNew();
            var result = new CommandResult(-1, "", "Operation did not complete.");
            var actionId = Guid.NewGuid();
            try
            {
                var arguments = ControlCommands.Lifecycle(name, op, timeout);
                _lifecycle.Add(actionId, new ContainerRequest(name, op, "bulk"));
                result = await Wslc.Client.RunAsync(arguments, token, TimeSpan.FromSeconds(timeout + 30));
            }
            catch (OperationCanceledException)
            {
                var activity = _activity.Action(Now(), new ContainerRequest(name, op, "bulk"), false,
                    "Cancelled after dispatch; the runtime action may still finish. Refresh its state.", watch.ElapsedMilliseconds);
                activity.Detail!["outcome"] = "cancelled";
                Persist(() => [_store.Record(activity)]);
                throw;
            }
            catch (Exception e) { result = new CommandResult(-1, "", e.Message); }
            finally { _lifecycle.Remove(actionId); Send(new { type = "busy", name, busy = false }); }
            Persist(() => [_store.Record(_activity.Action(Now(), new ContainerRequest(name, op, "bulk"), result.Code == 0, result.Combined, watch.ElapsedMilliseconds))]);
            var row = new { name, ok = result.Code == 0, output = result.Combined, ms = watch.ElapsedMilliseconds };
            results.Add(row);
            Send(new { type = "bulk-result", result = row });
        }
        return new { results };
    }

    private static object OpenRuntimeSettings()
    {
        Process.Start(new ProcessStartInfo(Wslc.Exe ?? throw new InvalidOperationException("wslc is missing."), ["settings"]) { UseShellExecute = true });
        return new { message = "Opened WSLc's settings in your editor. Changes apply according to WSLc's session lifecycle; existing storage is not migrated." };
    }

    private async Task<object> TerminateSessionAsync(JsonElement parameters, CancellationToken token)
    {
        var confirmed = parameters.TryGetProperty("confirmed", out var confirmation) && confirmation.ValueKind == JsonValueKind.True;
        var requested = parameters.TryGetProperty("session", out var session) ? session.GetString() ?? "" : "";
        var args = ControlCommands.TerminateSession(Wslc.Session, requested, confirmed);
        _sessionPaused = true;
        Send(new { type = "session-paused", paused = true });
        foreach (var pending in _operations.Values.ToArray())
            if (pending.Token != token) pending.Cancel();
        var deadline = Stopwatch.StartNew();
        while (_takingSnapshot || _probing || _eventsRunning || _lifecycle.Count > 0 || _operations.Count > 1)
        {
            if (deadline.Elapsed > TimeSpan.FromSeconds(40)) throw new InvalidOperationException("Existing reads have not finished, so no termination was sent. Monitoring remains paused.");
            await Task.Delay(100, token);
        }
        try
        {
            var result = await Wslc.Client.RunAsync(args, token);
            result.RequireSuccess();
        }
        catch (Exception e) { e.Data["actionSent"] = true; throw; }
        return new { message = "The selected session was terminated. Monitoring is paused; Resume monitoring can start the session again." };
    }

    private object ResumeSession()
    {
        _sessionPaused = false;
        Send(new { type = "session-paused", paused = false });
        return new { message = "Monitoring resumed. WSLc may start the selected session." };
    }

    private static async Task<object> ReadinessAsync(JsonElement parameters, CancellationToken token)
    {
        ObjectName(parameters);
        if (!Uri.TryCreate(Required(parameters, "url"), UriKind.Absolute, out var url)
            || url.Scheme is not ("http" or "https") || url.UserInfo.Length > 0)
            throw new ArgumentException("Use an HTTP or HTTPS URL without credentials.");
        // Private and loopback destinations need explicit confirmation, and the resolved address set is
        // pinned inside the connect callback so DNS rebinding cannot swap public for private in between.
        var resolved = await NetworkGuard.ResolveAsync(url.IdnHost, token);
        var restricted = NetworkGuard.IsRestricted(resolved);
        if (restricted && !Confirmed(parameters))
            throw new ArgumentException($"'{url.IdnHost}' resolves to a private or loopback address. Probe it again to confirm.");
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false };
        handler.ConnectCallback = NetworkGuard.ValidatingConnect(url.IdnHost, restricted);
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        var watch = Stopwatch.StartNew();
        try
        {
            using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
            return new { ok = response.IsSuccessStatusCode, status = (int)response.StatusCode,
                detail = $"Windows HTTP probe returned {(int)response.StatusCode} {response.ReasonPhrase}.", ms = watch.ElapsedMilliseconds };
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !token.IsCancellationRequested)
        {
            return new { ok = false, status = 0, detail = e.Message, ms = watch.ElapsedMilliseconds };
        }
    }

    private static bool Confirmed(JsonElement parameters) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("confirmed", out var flag)
        && flag.ValueKind == JsonValueKind.True;

    private object PickPath(JsonElement parameters)
    {
        var kind = Required(parameters, "kind");
        var suggested = parameters.TryGetProperty("suggested", out var suggestion) ? Path.GetFileName(suggestion.GetString() ?? "") : "";
        string? path = kind switch
        {
            "folder" => PickFolder(),
            "file" => PickFile(),
            "save" => PickSave(),
            _ => throw new ArgumentException("Unknown path selection type."),
        };
        return new { path };
        string? PickFolder() { var dialog = new OpenFolderDialog(); return dialog.ShowDialog(this) == true ? dialog.FolderName : null; }
        string? PickFile() { var dialog = new OpenFileDialog { CheckFileExists = true }; return dialog.ShowDialog(this) == true ? dialog.FileName : null; }
        string? PickSave() { var dialog = new SaveFileDialog { FileName = suggested, OverwritePrompt = true }; return dialog.ShowDialog(this) == true ? dialog.FileName : null; }
    }

    internal void ShowWindow()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    private void EnsureTray()
    {
        if (_tray is not null) return;
        try { _tray = new Tray(this, ShowWindow, TrayMenu); }
        catch (Exception e) { Send(new { type = "error", title = "Tray unavailable", message = e.Message }); }
    }

    private async Task RetryTrayAsync()
    {
        if (_trayRetryStarted) return;
        _trayRetryStarted = true;
        try
        {
            await Task.Delay(3000, _closing.Token);
            EnsureTray();
            if (_tray is not null && _preferences.KeepRunning && Environment.GetCommandLineArgs().Contains("--background")) Hide();
        }
        catch (OperationCanceledException) { }
    }

    private ContextMenu TrayMenu()
    {
        var menu = new ContextMenu();
        void Add(string label, Action action) { var item = new MenuItem { Header = label }; item.Click += (_, _) => action(); menu.Items.Add(item); }
        Add("Open Watcher", ShowWindow);
        foreach (var group in (_latest?.Containers ?? []).GroupBy(c => c.Info.Group ?? "Other").Take(8))
        {
            var names = group.Select(c => c.Info.Name).ToArray();
            Add($"Start {group.Key}", () => _ = TrayBulkAsync(names, "start"));
            Add($"Stop {group.Key}…", () =>
            {
                if (MessageBox.Show($"Stop these containers in {group.Key}?\n\n{string.Join("\n", names)}", "Watcher", MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK)
                    _ = TrayBulkAsync(names, "stop");
            });
        }
        menu.Items.Add(new Separator());
        Add("Quit Watcher", () => { _exit = true; Close(); });
        return menu;
    }

    private async Task TrayBulkAsync(string[] names, string op)
    {
        try
        {
            var result = await ManageAsync(JsonSerializer.SerializeToElement(new { operation = "bulk", parameters = new { names, op, timeout = 10 } }));
            var rows = JsonSerializer.SerializeToElement(result, Json).GetProperty("results").EnumerateArray().ToList();
            var passed = rows.Count(row => row.GetProperty("ok").GetBoolean());
            _tray?.Notify("Watcher", $"{op}: {passed} succeeded, {rows.Count - passed} failed. Open Watcher for details.");
        }
        catch (Exception e) { _tray?.Notify("Watcher action failed", e.Message); }
    }

    private void Notify(StoredEvent activity)
    {
        var rule = activity.Container is { } name && _preferences.ContainerAlerts?.TryGetValue(name, out var custom) == true ? custom : _preferences.EffectiveAlerts;
        if (!rule.Notifications || rule.Muted) return;
        // Notability comes from structured detail fields, never from owner-controlled summary text:
        // a container named to contain "exited" must not fire or suppress alerts (CWE-290).
        var notable = activity.Kind is ActivityKind.CpuHigh or ActivityKind.MemoryHigh or ActivityKind.WslcOffline or ActivityKind.Limit
            || activity.Kind == ActivityKind.State && EnteredStoppedState(activity.Detail)
            || activity.Kind == "runtime" && RuntimeUnhealthy(activity.Detail);
        if (!notable) return;
        var key = $"{activity.Kind}/{activity.Container}";
        if (_notified.TryGetValue(key, out var previous) && activity.At - previous < rule.CooldownSeconds * 1000L) return;
        _notified[key] = activity.At;
        EnsureTray();
        _tray?.Notify("Watcher", activity.Summary);
    }

    /// <summary>A state change is alert-worthy when the container moved into a stopped state, per the structured detail.</summary>
    private static bool EnteredStoppedState(System.Text.Json.Nodes.JsonObject? detail) =>
        detail?["to"]?.ToString() is "exited" or "dead";

    /// <summary>Runtime health events are alert-worthy when the structured action reports unhealthy.</summary>
    private static bool RuntimeUnhealthy(System.Text.Json.Nodes.JsonObject? detail) =>
        detail?["Action"]?.ToString() is { } action && action.EndsWith("unhealthy", StringComparison.OrdinalIgnoreCase);

    private async Task CaptureRuntimeEventsAsync(long at)
    {
        if (_sessionPaused || _eventsRunning || at < _nextEvents || _closing.IsCancellationRequested) return;
        _eventsRunning = true;
        _nextEvents = at + 10_000;
        try
        {
            var end = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var data = await (_management ??= new Management(Wslc.Client)).HandleAsync("events",
                JsonSerializer.SerializeToElement(new { since = _eventSince.ToString(System.Globalization.CultureInfo.InvariantCulture) }), _closing.Token);
            var json = JsonSerializer.SerializeToElement(data, Json);
            foreach (var entry in json.GetProperty("entries").EnumerateArray())
            {
                var key = entry.GetRawText();
                if (!_eventIds.Add(key)) continue;
                _eventOrder.Enqueue(key);
                while (_eventOrder.Count > 2000) _eventIds.Remove(_eventOrder.Dequeue());
                var action = entry.TryGetProperty("Action", out var a) ? a.ToString() : entry.TryGetProperty("status", out a) ? a.ToString() : "event";
                string? name = null;
                if (entry.TryGetProperty("Actor", out var actor) && actor.TryGetProperty("Attributes", out var attributes) && attributes.TryGetProperty("name", out var n)) name = n.ToString();
                Persist(() => [_store.Record(new ActivityEvent(Inspection.EventTime(entry, Now()), "runtime", name, $"Runtime {action}{(name is null ? "" : $": {name}")}", JsonNode.Parse(entry.GetRawText()) as JsonObject))]);
            }
            _eventSince = end;
            _eventError = null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Send(new { type = "runtime-gap", message = e.Message });
            if (_eventError != e.Message)
            {
                _eventError = e.Message;
                Persist(() => [_store.Record(new ActivityEvent(Now(), "runtime-gap", null,
                    "Runtime event collection unavailable; snapshot monitoring continues.", new() { ["message"] = e.Message }))]);
            }
            _nextEvents = at + 60_000;
        }
        finally { _eventsRunning = false; }
    }
}
