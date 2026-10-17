using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Watcher;

/// <summary>A frameless window around the WebView2 UI in web/, bridging page messages to wslc and Win32.</summary>
public partial class MainWindow : Window
{
    private static readonly string DataFolder = Store.Folder;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The sparklines only reach back this far on a restart, so a gap of hours never draws as one line.</summary>
    private const long PreloadWindowMs = 10 * 60_000;

    /// <summary>WSL's size only changes when its VM restarts; a failed probe (no running container has sh) retries sooner.</summary>
    private const long ProbeEveryMs = 10 * 60_000;
    private const long ProbeRetryMs = 60_000;

    private readonly Monitor _monitor = new(Settings.Load(Path.Combine(DataFolder, "settings.json")));
    private readonly Store _store = new(Store.DefaultPath);
    private readonly ActivityTracker _activity;
    private readonly CancellationTokenSource _closing = new();
    private string? _storeError;
    private bool _polling;
    private Capacities _capacity = Capacities.Unmeasured(Capacity.Windows());
    private long _probeAt;
    private bool _probing;

    public MainWindow()
    {
        InitializeComponent();
        _activity = new ActivityTracker(_store.LoadContainers());
        _activity.Configure(_preferences);
        _monitor.Preload(_store.LoadHistory(Now() - PreloadWindowMs, Monitor.HistoryLength));
        RestorePlacement();
        StateChanged += (_, _) => OnStateChanged();
        Closing += (_, args) =>
        {
            SavePlacement();
            if (!_exit && _preferences.KeepRunning)
            {
                EnsureTray();
                if (_tray is not null)
                {
                    args.Cancel = true;
                    Hide();
                    return;
                }
            }
            if (_polling)
            {
                Persist(() => [_store.Record(ActivityTracker.Stopped(Now()))]);
            }
        };
        Closed += (_, _) =>
        {
            RecordInterruptedActions();
            _closing.Cancel();
            foreach (var operation in _operations.Values) operation.Cancel();
            _tray?.Dispose();
            _store.Dispose();
        };
        Loaded += async (_, _) => await StartAsync();
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private async Task StartAsync()
    {
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(DataFolder, "WebView2"));
        await Web.EnsureCoreWebView2Async(environment);
        var core = Web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        if (Environment.GetEnvironmentVariable("WATCHER_VERIFY_OUTPUT") is not null)
        {
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__watcherErrors=[];addEventListener('error',e=>window.__watcherErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__watcherErrors.push(String(e.reason)))");
        }
        core.SetVirtualHostNameToFolderMapping("app.watcher", Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Allow);
        core.NavigationStarting += (_, e) =>
        {
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "app.watcher") e.Cancel = true;
        };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.WebMessageReceived += (_, e) =>
        {
            if (Uri.TryCreate(e.Source, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host == "app.watcher") OnMessage(e.WebMessageAsJson);
        };
        core.NavigationCompleted += (_, _) =>
        {
            Send(new { type = "window", maximized = WindowState == WindowState.Maximized });
            if (Wslc.Exe is null)
            {
                Send(new { type = "missing" });
            }
            else if (!_polling)
            {
                _polling = true;
                _ = PollAsync(_closing.Token);
            }
            if (_preferences.KeepRunning || _preferences.EffectiveAlerts.Notifications)
            {
                EnsureTray();
                if (_tray is null) _ = RetryTrayAsync();
            }
            if (Environment.GetCommandLineArgs().Contains("--background") && _preferences.KeepRunning && _tray is not null) Hide();
            _ = RunVerificationAsync();
        };
        core.Navigate("https://app.watcher/index.html");
    }

    /// <summary>wslc stats samples for about two seconds, so it sets the refresh rate.</summary>
    private async Task PollAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            if (_sessionPaused)
            {
                try { await Task.Delay(300, token); } catch (OperationCanceledException) { return; }
                continue;
            }
            if (!IsVisible && _latest is { } latest && latest.Containers.All(c => c.Info.State != "running"))
            {
                bool active;
                try
                {
                    _takingSnapshot = true;
                    active = await SessionActiveAsync(token);
                }
                finally { _takingSnapshot = false; }
                if (!active)
                {
                    await Task.Delay(10_000, token);
                    continue;
                }
            }
            if (_sessionPaused) continue;
            Snapshot? snapshot = null;
            var failure = "";
            try
            {
                _takingSnapshot = true;
                var taken = await _monitor.SnapshotAsync(token);
                _latest = taken;
                Send(taken.ToPage(_capacity));
                snapshot = taken;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                failure = exception.Message;
            }
            finally { _takingSnapshot = false; }
            if (token.IsCancellationRequested)
            {
                return;
            }
            if (snapshot is not null)
            {
                Persist(() => _store.Write(snapshot, _activity.Observe(snapshot, _capacity.Wsl.Cpus)));
                _ = ProbeAsync(snapshot);
                if (IsVisible || snapshot.Containers.Any(c => c.Info.State == "running")) _ = CaptureRuntimeEventsAsync(snapshot.At);
            }
            else
            {
                Send(new { type = "offline", message = failure });
                Persist(() => _activity.Offline(Now(), failure).Select(_store.Record).ToList());
            }
            try
            {
                await Task.Delay(300, token);
            }
            catch (TaskCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Measures WSL's size with one short process when it is due; the poll loop never waits for it.</summary>
    private async Task ProbeAsync(Snapshot snapshot)
    {
        var running = snapshot.Containers.Where(c => c.Metrics is not null).Select(c => c.Info.Name).ToList();
        if (_sessionPaused || _probing || running.Count == 0 || snapshot.At < _probeAt)
        {
            return;
        }
        _probing = true;
        Capacity? wsl = null;
        try
        {
            wsl = await Capacity.ProbeAsync(running);
        }
        catch (Exception)
        {
            // A probe that cannot run counts as a failed one; Windows' size keeps standing in.
        }
        if (wsl is not null)
        {
            _capacity = _capacity.Measured(wsl);
        }
        _probeAt = Now() + (wsl is null ? ProbeRetryMs : ProbeEveryMs);
        _probing = false;
    }

    /// <summary>
    /// Writes, then pushes the recorded events to the page. Any failure is reported once per distinct error and
    /// swallowed, so recording can never stop the poll loop.
    /// </summary>
    private void Persist(Func<IReadOnlyList<StoredEvent>> write)
    {
        if (_closing.IsCancellationRequested)
        {
            return;
        }
        try
        {
            foreach (var stored in write())
            {
                Send(new { type = "event", @event = stored });
                Notify(stored);
            }
            _storeError = null;
        }
        catch (Exception exception)
        {
            if (_storeError != exception.Message)
            {
                _storeError = exception.Message;
                Send(new { type = "error", title = "Database write failed", message = $"{exception.Message}\n{_store.Path}" });
            }
        }
    }

    private void Send(object message)
    {
        if (!_closing.IsCancellationRequested && Web.CoreWebView2 is { } core)
        {
            core.PostWebMessageAsJson(JsonSerializer.Serialize(message, Json));
        }
    }

    private void OnMessage(string json)
    {
        using var document = JsonDocument.Parse(json);
        var message = document.RootElement;
        var name = message.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
        switch (message.GetProperty("type").GetString())
        {
            case "drag":
                NativeFrame(HtCaption);
                break;
            case "resize":
                NativeFrame(message.GetProperty("edge").GetString() switch
                {
                    "left" => 10, "right" => 11, "top" => 12, "topleft" => 13, "topright" => 14,
                    "bottom" => 15, "bottomleft" => 16, _ => 17,
                });
                break;
            case "minimize":
                WindowState = WindowState.Minimized;
                break;
            case "maximize":
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                break;
            case "close":
                Close();
                break;
            case "container":
                _ = RunAsync(message.Deserialize<ContainerRequest>(Json)!);
                break;
            case "folder":
                var path = message.GetProperty("path").GetString();
                if (path is not null && Directory.Exists(path))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", [path.Replace('/', '\\')]) { UseShellExecute = true });
                }
                break;
            case "query":
                _ = QueryAsync(message.Clone());
                break;
        }
    }

    /// <summary>Answers a page request ({type:"query", id, query, params}) with {type:"result", id, ok, data | error}.</summary>
    private async Task QueryAsync(JsonElement message)
    {
        var id = message.GetProperty("id").GetInt64();
        try
        {
            var data = await AnswerAsync(message.GetProperty("query").GetString(), message.TryGetProperty("params", out var p) ? p : default);
            Send(new { type = "result", id, ok = true, data });
        }
        catch (Exception exception)
        {
            Send(new { type = "result", id, ok = false, error = exception.Message });
        }
    }

    private sealed record RangeParams(string Range = "24h");

    private async Task<object?> AnswerAsync(string? query, JsonElement parameters)
    {
        T Read<T>(T fallback) => parameters.ValueKind == JsonValueKind.Object ? parameters.Deserialize<T>(Json) ?? fallback : fallback;
        var now = Now();
        switch (query)
        {
            case "manage":
                return await ManageAsync(parameters);
            case "stats":
                var range = Read(new RangeParams()).Range;
                var capacity = _capacity;
                return await Task.Run(() => _store.Stats(range, now, capacity));
            case "activity":
                var filter = Read(new ActivityQuery());
                filter = filter with { Limit = Math.Clamp(filter.Limit, 1, 500) };
                return await Task.Run(() => _store.Activity(filter));
            case "containers":
                return await Task.Run(_store.Containers);
            case "removed":
                var removed = Read(new RemovedQuery());
                removed = removed with { Offset = Math.Max(0, removed.Offset), Limit = Math.Clamp(removed.Limit, 0, 100) };
                return await Task.Run(() => _store.RemovedContainers(removed));
            case "export":
                return await ExportAsync(Read(new RangeParams()).Range, now);
            case "open-data-folder":
                Directory.CreateDirectory(DataFolder);
                Process.Start(new ProcessStartInfo("explorer.exe", [DataFolder]) { UseShellExecute = true });
                return null;
            default:
                throw new ArgumentException($"Unknown query '{query}'.");
        }
    }

    /// <summary>Copies the report and also saves it under exports, so a busy clipboard loses nothing.</summary>
    private async Task<object> ExportAsync(string range, long now)
    {
        var capacity = _capacity;
        var report = await Task.Run(() =>
        {
            var stats = _store.Stats(range, now, capacity);
            return Report.Markdown(range, stats, _store.Events(stats.From, stats.To), DateTimeOffset.Now, TimeZoneInfo.Local);
        });
        var folder = Path.Combine(DataFolder, "exports");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, $"watcher-{range}-{DateTime.Now:yyyyMMdd-HHmmss}.md");
        await File.WriteAllTextAsync(path, report);
        var copied = true;
        try
        {
            Clipboard.SetText(report);
        }
        catch (COMException)
        {
            copied = false;
        }

        return new { path, chars = report.Length, copied };
    }

    private async Task RunAsync(ContainerRequest request)
    {
        if (_sessionPaused)
        {
            Send(new { type = "error", title = "Monitoring paused", message = "Resume monitoring in Manage → Runtime before sending lifecycle actions." });
            return;
        }
        var (name, op) = (request.Name, request.Op);
        if (string.IsNullOrWhiteSpace(name) || name.StartsWith('-') || name.Any(char.IsControl))
        {
            Send(new { type = "error", title = "Invalid container", message = "Select a valid container name." });
            return;
        }
        var args = ControlCommands.Lifecycle(name, op);
        Send(new { type = "busy", name, busy = true });
        var watch = Stopwatch.StartNew();
        (int Code, string Output) result;
        var actionId = Guid.NewGuid();
        try
        {
            _lifecycle.Add(actionId, request);
            var command = await Wslc.Client.RunAsync(args, _closing.Token);
            result = (command.Code, command.Combined);
        }
        catch (Exception e) when (e is not OperationCanceledException) { result = (-1, e.Message); }
        catch (OperationCanceledException) { return; }
        finally { _lifecycle.Remove(actionId); Send(new { type = "busy", name, busy = false }); }
        Persist(() => [_store.Record(_activity.Action(Now(), request, result.Code == 0, result.Output, watch.ElapsedMilliseconds))]);
        if (result.Code != 0)
        {
            Send(new { type = "error", title = $"wslc {op} failed", message = result.Output.Trim() });
        }
    }

    // Hand the mouse press to Windows as if it landed on the frame, so drag, snap and resize stay native.
    private const int HtCaption = 2;
    private const int WmNcLeftButtonDown = 0xA1;

    private void NativeFrame(int hitTest)
    {
        var handle = new WindowInteropHelper(this).Handle;
        ReleaseCapture();
        SendMessage(handle, WmNcLeftButtonDown, hitTest, 0);
    }

    /// <summary>Square corners and the theme's border colour from DWM (Windows 11).</summary>
    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var handle = new WindowInteropHelper(this).Handle;
        // DWMWA_USE_IMMERSIVE_DARK_MODE, WINDOW_CORNER_PREFERENCE = DONOTROUND, BORDER_COLOR (0x00BBGGRR).
        foreach (var (attribute, value) in new[] { (20, 1), (33, 1), (34, 0x002E2E2E) })
        {
            var data = value;
            DwmSetWindowAttribute(handle, attribute, ref data, sizeof(int));
        }
    }

    /// <summary>A maximized chromeless window overhangs the screen by its resize border.</summary>
    private void OnStateChanged()
    {
        var maximized = WindowState == WindowState.Maximized;
        Root.Margin = maximized ? new Thickness(7) : new Thickness(0);
        Send(new { type = "window", maximized });
    }

    private sealed record Placement(double Left, double Top, double Width, double Height, bool Maximized);

    private static string PlacementFile => Path.Combine(DataFolder, "window.json");

    /// <summary>Reopen where it was closed, unless that spot is no longer on any screen.</summary>
    private void RestorePlacement()
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Placement>(File.ReadAllText(PlacementFile));
            if (saved is null || saved.Width < MinWidth || saved.Height < MinHeight)
            {
                return;
            }
            var onScreen = saved.Left + 80 > SystemParameters.VirtualScreenLeft
                && saved.Top >= SystemParameters.VirtualScreenTop
                && saved.Left + saved.Width - 80 < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth
                && saved.Top + 40 < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight;
            if (!onScreen)
            {
                return;
            }
            WindowStartupLocation = WindowStartupLocation.Manual;
            (Left, Top, Width, Height) = (saved.Left, saved.Top, saved.Width, saved.Height);
            if (saved.Maximized)
            {
                Loaded += (_, _) => WindowState = WindowState.Maximized;
            }
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
        }
    }

    private void SavePlacement()
    {
        var bounds = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        try
        {
            Directory.CreateDirectory(DataFolder);
            File.WriteAllText(PlacementFile, JsonSerializer.Serialize(
                new Placement(bounds.Left, bounds.Top, bounds.Width, bounds.Height, WindowState == WindowState.Maximized)));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int message, int wParam, int lParam);
}
