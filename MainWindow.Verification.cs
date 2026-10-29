using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace Watcher;

public partial class MainWindow
{
    private bool _verificationStarted;

    private async Task RunVerificationAsync()
    {
        var folder = Environment.GetEnvironmentVariable("WATCHER_VERIFY_OUTPUT");
        if (_verificationStarted || string.IsNullOrWhiteSpace(folder)) return;
        _verificationStarted = true;
        var results = new List<object>();
        Directory.CreateDirectory(folder);
        try
        {
            await Task.Delay(1000, _closing.Token);
            var name = Environment.GetEnvironmentVariable("WATCHER_VERIFY_CONTAINER") ?? "";
            var encodedName = JsonSerializer.Serialize(name);
            foreach (var route in new[] { "containers", "manage", "logs", "stats", "activity", "resources" })
            {
                await EvaluateAsync($"location.hash = '#{route}'; true");
                await Task.Delay(1600, _closing.Token);
                var state = await EvaluateAsync("({route:location.hash,body:document.body.innerText,errors:window.__watcherErrors??[],width:document.documentElement.scrollWidth,viewport:innerWidth})");
                if (state.GetProperty("route").GetString() != "#" + route) throw new InvalidOperationException($"The {route} route did not open.");
                if (state.GetProperty("errors").GetArrayLength() > 0) throw new InvalidOperationException(state.GetProperty("errors").ToString());
                if (state.GetProperty("width").GetInt32() > state.GetProperty("viewport").GetInt32()) throw new InvalidOperationException($"The {route} page overflows horizontally.");
                results.Add(new { route, state });
                await using var screenshot = File.Create(Path.Combine(folder, route + ".png"));
                await Web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, screenshot);
            }
            await EvaluateAsync("location.hash = '#manage'; true");
            foreach (var tab in new[] { "images", "volumes", "networks", "storage", "runtime", "preferences" })
            {
                await EvaluateAsync($"document.getElementById('mg-tab-{tab}').click(); true");
                var until = DateTime.UtcNow.AddSeconds(25);
                JsonElement state;
                do
                {
                    await Task.Delay(200, _closing.Token);
                    state = await EvaluateAsync($"({{selected:document.getElementById('mg-tab-{tab}').getAttribute('aria-selected'),busy:document.querySelectorAll('#mg-panel-{tab} .mg-status.busy').length,text:document.getElementById('mg-panel-{tab}').innerText,errors:window.__watcherErrors??[]}})");
                } while (state.GetProperty("busy").GetInt32() > 0 && DateTime.UtcNow < until);
                if (state.GetProperty("selected").GetString() != "true" || state.GetProperty("errors").GetArrayLength() > 0 || state.GetProperty("busy").GetInt32() > 0)
                    throw new InvalidOperationException($"Management tab {tab} failed to settle: {state}");
                results.Add(new { managementTab = tab, state });
                await using var shot = File.Create(Path.Combine(folder, "manage-" + tab + ".png"));
                await Web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
            }
            await VerifyPlotKeyboardAsync(results);
            if (name.Length > 0)
            {
                var inspect = await EvaluateAsync("(async()=>{const {request}=await import('./app.js');return await request('manage',{operation:'inspect',parameters:{name:" + encodedName + "}})})()");
                if (inspect.GetProperty("name").GetString() != name) throw new InvalidOperationException("The inspect bridge returned a different container.");
                if (inspect.GetProperty("limits").GetProperty("memoryBytes").GetInt64() != 64 * 1024 * 1024) throw new InvalidOperationException("The inspector did not return the fixture's 64 MiB memory budget.");
                var token = Environment.GetEnvironmentVariable("WATCHER_VERIFY_TOKEN");
                if (!name.StartsWith("watcher-proof-", StringComparison.Ordinal) || string.IsNullOrEmpty(token)
                    || !inspect.GetProperty("raw").GetProperty("Labels").TryGetProperty("watcher.proof", out var label) || label.GetString() != token)
                    throw new InvalidOperationException("The verification target is not an owned proof container.");
                results.Add(new { operation = "inspect", data = inspect });
                if (Environment.GetEnvironmentVariable("WATCHER_VERIFY_LOG_CONTROLS") == "1") await VerifyLogControlsAsync(name, folder);
                if (Environment.GetEnvironmentVariable("WATCHER_VERIFY_SETTINGS") == "1") await VerifyRuntimeSettingsAsync(folder);
                var logs = await EvaluateAsync("(async()=>{const {request}=await import('./app.js');return await request('manage',{operation:'logs',parameters:{names:[" + encodedName + "],tail:100}})})()");
                if (!logs.GetProperty("entries").EnumerateArray().Any(e => e.GetProperty("text").GetString()?.Contains("watcher-proof-started", StringComparison.Ordinal) == true)) throw new InvalidOperationException("The logs bridge did not return the fixture marker.");
                results.Add(new { operation = "logs", data = logs });
                await EvaluateAsync("window.dispatchEvent(new CustomEvent('watcher:logs',{detail:{name:" + encodedName + "}}));true");
                var logDeadline = DateTime.UtcNow.AddSeconds(10);
                while (!(await EvaluateAsync("document.querySelector('section[data-page=\"logs\"]').innerText.includes('watcher-proof-started')")).GetBoolean())
                {
                    if (DateTime.UtcNow > logDeadline) throw new InvalidOperationException("The Logs page did not render the fixture marker.");
                    await Task.Delay(200, _closing.Token);
                }
                await using (var shot = File.Create(Path.Combine(folder, "logs-live.png")))
                    await Web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
                results.Add(new { operation = "logs-rendered", ok = true });
                var files = await EvaluateAsync("(async()=>{const {request}=await import('./app.js');return await request('manage',{operation:'files',parameters:{name:" + encodedName + ",path:'/data',confirmed:true}})})()");
                if (!files.GetProperty("entries").EnumerateArray().Any(e => e.GetProperty("name").GetString() == "marker.txt")) throw new InvalidOperationException("The files bridge did not list the mounted fixture marker.");
                results.Add(new { operation = "files", data = files });
                var copyPath = Path.Combine(folder, "copied-marker.txt");
                await BridgeAsync("copy", new { name, containerPath = "/data/marker.txt", hostPath = copyPath, direction = "out", confirmed = true });
                if (!File.Exists(copyPath) || await File.ReadAllTextAsync(copyPath) != "watcher-backup") throw new InvalidOperationException("The native copy did not preserve the fixture marker.");
                results.Add(new { operation = "copy-out", ok = true });
                await BridgeAsync("copy", new { name, containerPath = "/data/", hostPath = copyPath, direction = "in", confirmed = true });
                var imported = await BridgeAsync("files", new { name, path = "/data/copied-marker.txt", confirmed = true });
                if (imported.GetProperty("text").GetString() != "watcher-backup") throw new InvalidOperationException("The native copy into the container did not preserve the marker.");
                results.Add(new { operation = "copy-in", ok = true });
                var stopped = await BridgeAsync("bulk", new { names = new[] { name }, op = "stop", timeout = 5 });
                if (!stopped.GetProperty("results")[0].GetProperty("ok").GetBoolean()) throw new InvalidOperationException("The owned fixture did not stop.");
                var volume = Environment.GetEnvironmentVariable("WATCHER_VERIFY_VOLUME");
                if (!string.IsNullOrWhiteSpace(volume))
                {
                    var backup = Path.Combine(folder, "volume-backup");
                    await BridgeAsync("volume-backup", new { name = volume, path = backup, container = name, containerPath = "/data", confirmed = true });
                    var markers = Directory.Exists(backup) ? Directory.GetFiles(backup, "marker.txt", SearchOption.AllDirectories) : [];
                    if (markers.Length != 1 || await File.ReadAllTextAsync(markers[0]) != "watcher-backup") throw new InvalidOperationException("The stopped volume backup did not preserve the marker.");
                    results.Add(new { operation = "volume-backup", ok = true });
                }
                var started = await BridgeAsync("bulk", new { names = new[] { name }, op = "start", timeout = 5 });
                if (!started.GetProperty("results")[0].GetProperty("ok").GetBoolean()) throw new InvalidOperationException("The owned fixture did not start again.");
                var restarted = await BridgeAsync("bulk", new { names = new[] { name }, op = "restart", timeout = 5 });
                if (!restarted.GetProperty("results")[0].GetProperty("ok").GetBoolean()) throw new InvalidOperationException("The owned fixture did not restart.");
                results.Add(new { operation = "bulk-start-stop-restart", ok = true });
                await Task.Delay(1100, _closing.Token);
                var runtimeEvents = await BridgeAsync("events", new { since = DateTimeOffset.UtcNow.AddMinutes(-2).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture) });
                var containerId = inspect.GetProperty("raw").GetProperty("Id").GetString()!;
                if (!runtimeEvents.GetProperty("entries").EnumerateArray().Any(e => e.GetRawText().Contains(name, StringComparison.Ordinal) || e.GetRawText().Contains(containerId, StringComparison.Ordinal)))
                    throw new InvalidOperationException("The native event query did not return the owned fixture's lifecycle.");
                results.Add(new { operation = "runtime-events", ok = true });
                var port = Environment.GetEnvironmentVariable("WATCHER_VERIFY_PORT");
                if (int.TryParse(port, out var hostPort))
                {
                    var probe = await EvaluateAsync("(async()=>{const {request}=await import('./app.js');return await request('manage',{operation:'readiness',parameters:{name:" + encodedName + ",url:'http://127.0.0.1:" + hostPort + "/',confirmed:true}})})()");
                    if (!probe.GetProperty("ok").GetBoolean() || probe.GetProperty("status").GetInt32() != 200) throw new InvalidOperationException("The Windows HTTP readiness probe did not reach the fixture.");
                    results.Add(new { operation = "readiness", data = probe });
                }
                await EvaluateAsync("window.dispatchEvent(new CustomEvent('watcher:inspect',{detail:{name:" + encodedName + "}}));true");
                await Task.Delay(1200, _closing.Token);
                await using var screenshot = File.Create(Path.Combine(folder, "inspect.png"));
                await Web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, screenshot);
            }
            await File.WriteAllTextAsync(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { ok = true, results }, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception exception)
        {
            await File.WriteAllTextAsync(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { ok = false, error = exception.ToString(), results }, new JsonSerializerOptions { WriteIndented = true }));
        }
        finally
        {
            _exit = true;
            Close();
        }
    }

    /// <summary>The Stats plots read without a mouse: focus, arrow keys, Home and End, and every sample announced.</summary>
    private async Task VerifyPlotKeyboardAsync(List<object> results)
    {
        // The proof window may not be the active one; the page still has to behave as if it were.
        await Web.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled", """{"enabled":true}""");
        const string reload = """document.querySelector('#stats-range button[data-range="1h"]').click(); true""";
        await EvaluateAsync("location.hash = '#stats'; " + reload);
        var until = DateTime.UtcNow.AddSeconds(90);
        JsonElement home, end;
        while (true)
        {
            await Task.Delay(2000, _closing.Token);
            await EvaluateAsync("document.getElementById('stats-cpu').focus(); true");
            home = await PressInPlotAsync("Home", 36);
            end = await PressInPlotAsync("End", 35);
            if (home.GetProperty("announced").GetString() != end.GetProperty("announced").GetString()) break;
            // Nothing to step between yet: no plot drawn, or one sample. Ask again for newer samples.
            if (DateTime.UtcNow > until) throw new InvalidOperationException($"The Stats plot never had two samples to step between: {home} {end}");
            await EvaluateAsync(reload);
        }
        if (!home.GetProperty("matches").GetBoolean() || !end.GetProperty("matches").GetBoolean())
            throw new InvalidOperationException($"Home and End must show a readout and announce the same sample: {home} {end}");
        var left = await PressInPlotAsync("ArrowLeft", 37);
        if (left.GetProperty("announced").GetString() == end.GetProperty("announced").GetString() || !left.GetProperty("matches").GetBoolean())
            throw new InvalidOperationException($"ArrowLeft did not move off the newest sample: {left}");
        var right = await PressInPlotAsync("ArrowRight", 39);
        if (right.GetProperty("announced").GetString() != end.GetProperty("announced").GetString())
            throw new InvalidOperationException($"ArrowRight did not come back to the newest sample: {right}");
        await PressInPlotAsync("Home", 36);
        var past = await PressInPlotAsync("ArrowLeft", 37);
        if (past.GetProperty("announced").GetString() != home.GetProperty("announced").GetString())
            throw new InvalidOperationException($"ArrowLeft went past the oldest sample: {past}");
        var escaped = await PressInPlotAsync("Escape", 27);
        if (escaped.GetProperty("shown").GetBoolean()) throw new InvalidOperationException($"Escape did not hide the readout: {escaped}");
        results.Add(new { plotKeyboard = new { home, end, left, right, escaped } });
        await EvaluateAsync("document.activeElement.blur(); location.hash = '#manage'; true");
    }

    /// <summary>Sends one real key press to the page, then reads the CPU plot's readout and what was announced.</summary>
    private async Task<JsonElement> PressInPlotAsync(string key, int keyCode)
    {
        foreach (var type in new[] { "rawKeyDown", "keyUp" })
            await Web.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchKeyEvent", JsonSerializer.Serialize(new { type, key, code = key, windowsVirtualKeyCode = keyCode, nativeVirtualKeyCode = keyCode }));
        return await EvaluateAsync("""
            (() => {
                const holder = document.getElementById('stats-cpu');
                const readout = holder.querySelector('.sd-plot-readout');
                const shown = !!readout && !readout.hidden;
                const announced = holder.nextElementSibling?.textContent ?? '';
                return {
                    focused: document.activeElement === holder,
                    shown,
                    readout: readout?.textContent ?? '',
                    announced,
                    matches: shown && announced.length > 0
                        && announced.startsWith(readout.firstChild.textContent)
                        && announced.endsWith(', ' + readout.querySelector('b').textContent)
                };
            })()
            """);
    }

    private async Task<JsonElement> EvaluateAsync(string expression)
    {
        var result = await Web.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", JsonSerializer.Serialize(new { expression, awaitPromise = true, returnByValue = true }));
        using var json = JsonDocument.Parse(result);
        if (json.RootElement.TryGetProperty("exceptionDetails", out var failure)) throw new InvalidOperationException(failure.ToString());
        return json.RootElement.GetProperty("result").TryGetProperty("value", out var value) ? value.Clone() : JsonSerializer.SerializeToElement<object?>(null);
    }

    private Task<JsonElement> BridgeAsync(string operation, object parameters)
    {
        var payload = JsonSerializer.Serialize(new { operation, parameters }, Json);
        return EvaluateAsync("(async()=>{const {request}=await import('./app.js');return await request('manage'," + payload + ")})()");
    }
}
