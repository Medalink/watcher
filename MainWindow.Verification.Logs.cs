using System.IO;
using System.Text.Json;

namespace Watcher;

public partial class MainWindow
{
    private async Task VerifyRuntimeSettingsAsync(string folder)
    {
        var settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "wslc", "settings.yaml");
        var existed = File.Exists(settings);
        await EvaluateAsync("location.hash='#manage';true");
        await Task.Delay(200, _closing.Token);
        await EvaluateAsync("document.getElementById('mg-tab-runtime').click();true");
        await Task.Delay(700, _closing.Token);
        await EvaluateAsync("[...document.querySelectorAll('#mg-panel-runtime button')].find(x=>x.textContent==='Open runtime settings…').click();true");
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(settings) && DateTime.UtcNow < deadline) await Task.Delay(100, _closing.Token);
        var ui = await EvaluateAsync("document.getElementById('mg-panel-runtime').innerText");
        var ok = File.Exists(settings) && ui.GetString()!.Contains("Opened WSLc's settings", StringComparison.Ordinal);
        await File.WriteAllTextAsync(Path.Combine(folder, "runtime-settings.json"), JsonSerializer.Serialize(new
        {
            ok, existedBefore = existed, path = settings, ui,
            sha256 = File.Exists(settings) ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(await File.ReadAllBytesAsync(settings))) : null,
        }, new JsonSerializerOptions { WriteIndented = true }));
        if (!ok) throw new InvalidOperationException("The runtime settings action did not create/find settings and report the native launch.");
    }

    private async Task VerifyLogControlsAsync(string name, string folder)
    {
        var target = JsonSerializer.Serialize(name);
        await EvaluateAsync("window.dispatchEvent(new CustomEvent('watcher:logs',{detail:{name:" + target + "}}));true");
        await Task.Delay(600, _closing.Token);
        await EvaluateAsync("""
            (() => {
              const p = document.querySelector('section[data-page="logs"]');
              const b = text => [...p.querySelectorAll('button')].find(x => x.textContent === text);
              b('Stop following')?.click();
              const fields = p.querySelectorAll('input[type="datetime-local"]');
              fields[0].value = '2026-10-16T12:00';
              fields[1].value = '2026-10-16T11:00';
              b('Follow').click();
              return true;
            })()
            """);
        await Task.Delay(700, _closing.Token);
        var follow = await EvaluateAsync("""
            (() => {
              const p = document.querySelector('section[data-page="logs"]');
              return { following: [...p.querySelectorAll('button')].some(x => x.textContent === 'Stop following'), status: p.querySelector('.mg-status').textContent };
            })()
            """);
        var missing = JsonSerializer.Serialize(name + "-missing");
        await EvaluateAsync("window.dispatchEvent(new CustomEvent('watcher:logs',{detail:{name:" + missing + ",until:new Date().toISOString()}}));true");
        await Task.Delay(700, _closing.Token);
        await EvaluateAsync("[...document.querySelectorAll('section[data-page=\"logs\"] button')].find(x=>x.textContent==='None').click();true");
        var none = await EvaluateAsync("""
            (() => {
              const p = document.querySelector('section[data-page="logs"]');
              return { checked: p.querySelectorAll('.mg-picker input:checked').length, fetchDisabled: [...p.querySelectorAll('button')].find(x => x.textContent === 'Fetch').disabled };
            })()
            """);
        var ok = follow.GetProperty("following").GetBoolean() && none.GetProperty("checked").GetInt32() == 0 && none.GetProperty("fetchDisabled").GetBoolean();
        await File.WriteAllTextAsync(Path.Combine(folder, "log-controls.json"), JsonSerializer.Serialize(new { ok, follow, none }, new JsonSerializerOptions { WriteIndented = true }));
        if (!ok) throw new InvalidOperationException("Log controls did not ignore Until during Follow or clear missing selections with None. See log-controls.json.");
    }
}
