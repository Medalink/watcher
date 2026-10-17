using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Watcher.Tests;

public sealed class ManagementTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private const string NotFound = "Container 'ghost' not found.\nError code: WSLC_E_CONTAINER_NOT_FOUND\nIf this error was unexpected, please consider searching for existing issues or filing a new issue at https://github.com/microsoft/WSL/issues.\n";

    private const string WebInspect = """
        [{"Config":{"Cmd":["nginx","-g","daemon off;","--password=hunter2"],"Entrypoint":["/docker-entrypoint.sh"],"Env":["PATH=/usr/bin","DB_PASSWORD=hunter2"],"Healthcheck":null,"Image":"nginx:1.27","Labels":{"api_token":"hunter2","team":"web"},"StopTimeout":null,"User":"101","WorkingDir":"/srv"},"Created":"2026-10-16T21:07:34Z","HostConfig":{"Memory":536870912,"NanoCpus":1500000000,"NetworkMode":"bridge","Ulimits":[]},"Id":"abc123","Image":"sha256:9844","Labels":{"api_token":"hunter2","team":"web"},"Mounts":[{"Destination":"/data","Name":"webdata","ReadWrite":true,"Source":"","Type":"volume"}],"Name":"/web","NetworkSettings":{"Networks":{"bridge":{"IPAddress":"172.17.0.3"}}},"Ports":{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]},"State":{"ExitCode":0,"FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy"},"Running":true,"StartedAt":"2026-10-16T21:07:35Z","Status":"running"}}]
        """;

    private readonly string _temp = Path.Combine(Path.GetTempPath(), "watcher-management-" + Guid.NewGuid().ToString("N"));

    public ManagementTests() => Directory.CreateDirectory(_temp);

    public void Dispose() => Directory.Delete(_temp, recursive: true);

    private sealed class FakeRunner(Func<IReadOnlyList<string>, CommandResult> respond) : ICommandRunner
    {
        public readonly List<string> Calls = [];
        public readonly List<TimeSpan?> Timeouts = [];
        public CancellationToken LastToken;

        public Task<CommandResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default, TimeSpan? timeout = null)
        {
            Calls.Add(string.Join(" ", arguments));
            Timeouts.Add(timeout);
            LastToken = cancellationToken;
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(respond(arguments));
        }
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private static FakeRunner Runner(params (string Prefix, CommandResult Result)[] script) => new(args =>
    {
        var line = string.Join(" ", args);
        return script.FirstOrDefault(s => line.StartsWith(s.Prefix, StringComparison.Ordinal)).Result
            ?? throw new Xunit.Sdk.XunitException($"Unexpected command: {line}");
    });

    private static CommandResult Ok(string output, string error = "") => new(0, output, error);

    private Management Service(FakeRunner runner) => new(runner, session: "", storageRoot: Path.Combine(_temp, "sessions"));

    private static async Task<string> Call(Management service, string operation, string parameters) =>
        JsonSerializer.Serialize(await service.HandleAsync(operation, JsonDocument.Parse(parameters).RootElement), Json);

    [Fact]
    public async Task Inspect_summarizes_a_container_and_masks_every_secret()
    {
        var runner = Runner(("container inspect", Ok(WebInspect)));

        var json = await Call(Service(runner), "inspect", """{"name":"web"}""");

        Assert.Equal(["container inspect --format json web"], runner.Calls);
        Assert.DoesNotContain("hunter2", json);
        var detail = JsonDocument.Parse(json).RootElement;
        Assert.Equal(
            """{"name":"web","health":"healthy","state":"running","exitCode":0,"command":["/docker-entrypoint.sh","nginx","-g","daemon off;","--password=••••"],"image":"nginx:1.27","user":"101","workingDir":"/srv","environment":["PATH=••••","DB_PASSWORD=••••"],"limits":{"cpus":1.5,"memoryBytes":536870912}}""",
            JsonSerializer.Serialize(new
            {
                name = detail.GetProperty("name"), health = detail.GetProperty("health"), state = detail.GetProperty("state"),
                exitCode = detail.GetProperty("exitCode"), command = detail.GetProperty("command"), image = detail.GetProperty("image"),
                user = detail.GetProperty("user"), workingDir = detail.GetProperty("workingDir"), environment = detail.GetProperty("environment"),
                limits = detail.GetProperty("limits"),
            }, Json));
        Assert.Equal("""{"api_token":"••••","team":"web"}""", detail.GetProperty("raw").GetProperty("Labels").GetRawText());
        Assert.Equal("""{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]}""", detail.GetProperty("ports").GetRawText());
        Assert.Equal("""{"bridge":{"IPAddress":"172.17.0.3"}}""", detail.GetProperty("networks").GetRawText());
    }

    [Fact]
    public async Task A_container_without_a_healthcheck_or_limits_reports_none()
    {
        var plain = WebInspect.Replace("""{"Status":"healthy"}""", "null").Replace("536870912", "0").Replace("1500000000", "0");

        var json = await Call(Service(Runner(("container inspect", Ok(plain)))), "inspect", """{"name":"web"}""");

        var detail = JsonDocument.Parse(json).RootElement;
        Assert.Equal("none", detail.GetProperty("health").GetString());
        Assert.Equal("""{"cpus":null,"memoryBytes":null}""", detail.GetProperty("limits").GetRawText());
    }

    [Fact]
    public async Task A_missing_container_fails_with_the_wslc_message_minus_its_boilerplate()
    {
        var runner = Runner(("container inspect", new CommandResult(1, "[]\n", NotFound)));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(Service(runner), "inspect", """{"name":"ghost"}"""));

        Assert.Equal("Inspecting container 'ghost' failed: Container 'ghost' not found. Error code: WSLC_E_CONTAINER_NOT_FOUND", error.Message);
    }

    [Theory]
    [InlineData("inspect", """{"name":"--all"}""")]
    [InlineData("inspect", """{"name":"web; rm -rf /"}""")]
    [InlineData("inspect", """{}""")]
    [InlineData("logs", """{"names":["web","-f"]}""")]
    [InlineData("logs", """{"names":["web"],"since":"yesterday"}""")]
    [InlineData("logs", """{"names":["web"],"tail":100000}""")]
    [InlineData("object-inspect", """{"kind":"container","name":"web"}""")]
    [InlineData("object-remove", """{"kind":"volume","name":"-q","confirmed":true}""")]
    [InlineData("network-connect", """{"network":"--driver-opt","name":"web","confirmed":true}""")]
    [InlineData("copy", """{"name":"web","containerPath":"/etc","hostPath":"out","direction":"out","confirmed":true}""")]
    [InlineData("copy", """{"name":"web:x","containerPath":"/etc","hostPath":"C:\\out","direction":"out","confirmed":true}""")]
    [InlineData("copy", """{"name":"web","containerPath":"etc","hostPath":"C:\\out","direction":"out","confirmed":true}""")]
    [InlineData("files", """{"name":"web","path":"relative"}""")]
    [InlineData("diagnose", """{"host":"-oProxyCommand","port":80}""")]
    [InlineData("diagnose", """{"host":"localhost"}""")]
    [InlineData("events", """{"since":"--until=0"}""")]
    [InlineData("shell", """{"command":"rm -rf /"}""")]
    public async Task Invalid_requests_are_refused_before_any_command_runs(string operation, string parameters)
    {
        var runner = Runner();

        await Assert.ThrowsAnyAsync<ArgumentException>(() => Call(Service(runner), operation, parameters));

        Assert.Empty(runner.Calls);
    }

    [Theory]
    [InlineData("object-remove", """{"kind":"image","name":"nginx:1.27"}""")]
    [InlineData("object-remove", """{"kind":"network","name":"web-net","confirmed":false}""")]
    [InlineData("network-connect", """{"network":"web-net","name":"web"}""")]
    [InlineData("image-save", """{"name":"nginx:1.27","path":"C:\\nowhere\\nginx.tar"}""")]
    [InlineData("object-remove", """{"kind":"network","name":"bridge","confirmed":true}""")]
    public async Task Changes_need_confirmation_and_builtin_networks_stay(string operation, string parameters)
    {
        var runner = Runner();

        await Assert.ThrowsAnyAsync<Exception>(() => Call(Service(runner), operation, parameters.Replace(@"C:\\nowhere", _temp.Replace(@"\", @"\\"))));

        Assert.Empty(runner.Calls);
    }

    [Fact]
    public async Task Logs_merge_both_streams_of_several_containers_in_time_order()
    {
        var runner = Runner(
            ("container logs --timestamps --tail 50 --since 2026-10-16T21:00:00Z --until 1792185000 api", Ok(
                "2026-10-16T21:09:31.5Z api started\n", "2026-10-16T21:09:31.829035057Z api warning\n")),
            ("container logs --timestamps --tail 50 --since 2026-10-16T21:00:00Z --until 1792185000 db", new CommandResult(0, "2026-10-16T21:09:31.6Z db ready\r\n", "", Truncated: true)));

        var json = await Call(Service(runner), "logs", """{"names":["api","db","api"],"tail":50,"since":"2026-10-16T21:00:00Z","until":"1792185000"}""");

        Assert.Equal(2, runner.Calls.Count);
        Assert.Equal(
            """{"entries":[{"container":"api","text":"2026-10-16T21:09:31.5Z api started","time":"2026-10-16T21:09:31.5Z"},{"container":"db","text":"2026-10-16T21:09:31.6Z db ready","time":"2026-10-16T21:09:31.6Z"},{"container":"api","text":"2026-10-16T21:09:31.829035057Z api warning","time":"2026-10-16T21:09:31.829035057Z"}],"truncated":true}""",
            json);
    }

    [Fact]
    public async Task Logs_default_to_the_last_200_lines_and_never_follow()
    {
        var runner = Runner(("container logs", Ok("")));

        var json = await Call(Service(runner), "logs", """{"names":["web"]}""");

        Assert.Equal(["container logs --timestamps --tail 200 web"], runner.Calls);
        Assert.Equal("""{"entries":[],"truncated":false}""", json);
    }

    [Fact]
    public async Task Inventory_lists_rows_without_creating_anything()
    {
        var runner = Runner(("network list", Ok("""
            {"Driver":"bridge","ID":"597f95ebf9f3","Name":"bridge"}
            {"Driver":"bridge","ID":"42b60c703220","Labels":"","Name":"web-net"}
            """)));

        var json = await Call(Service(runner), "inventory", """{"kind":"network"}""");

        Assert.Equal(["network list --format json"], runner.Calls);
        Assert.Equal("""{"items":[{"Driver":"bridge","ID":"597f95ebf9f3","Name":"bridge"},{"Driver":"bridge","ID":"42b60c703220","Labels":"","Name":"web-net"}]}""", json);
    }

    [Fact]
    public async Task Object_inspect_masks_volume_mount_passwords()
    {
        var runner = Runner(("volume inspect", Ok("""[{"Driver":"local","Name":"share","Options":{"o":"addr=10.0.0.5","password":"hunter2"}}]""")));

        var json = await Call(Service(runner), "object-inspect", """{"kind":"volume","name":"share"}""");

        Assert.Equal(["volume inspect --format json share"], runner.Calls);
        Assert.Equal("""{"raw":{"Driver":"local","Name":"share","Options":{"o":"addr=10.0.0.5","password":"••••"}}}""", json);
    }

    [Fact]
    public async Task A_network_with_members_is_not_removed()
    {
        var runner = Runner(("network inspect", Ok("""[{"Name":"web-net","Containers":{"92a7":{"Name":"web"},"a941":{"Name":"db"}}}]""")));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Call(Service(runner), "object-remove", """{"kind":"network","name":"web-net","confirmed":true}"""));

        Assert.Equal("Network 'web-net' is in use by web, db.", error.Message);
        Assert.Equal(["network inspect --format json web-net"], runner.Calls);
    }

    [Fact]
    public async Task An_empty_network_is_removed_without_force()
    {
        var runner = Runner(("network inspect", Ok("""[{"Name":"web-net","Containers":{}}]""")), ("network remove", Ok("web-net\n")));

        var json = await Call(Service(runner), "object-remove", """{"kind":"network","name":"web-net","confirmed":true}""");

        Assert.Equal(["network inspect --format json web-net", "network remove web-net"], runner.Calls);
        Assert.Equal("""{"message":"Removed network 'web-net'."}""", json);
    }

    [Fact]
    public async Task An_image_any_container_uses_is_not_removed()
    {
        var runner = Runner(
            ("image inspect", Ok("""[{"Id":"sha256:0ca930bba7140000","RepoTags":["iris-wt-pg:latest"]}]""")),
            ("image list", Ok("""{"Containers":"4","ID":"0ca930bba714","Repository":"iris-wt-pg","Tag":"latest"}""")));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Call(Service(runner), "object-remove", """{"kind":"image","name":"iris-wt-pg:latest","confirmed":true}"""));

        Assert.Equal("Image 'iris-wt-pg:latest' is used by 4 container(s); remove those containers first.", error.Message);
        Assert.DoesNotContain(runner.Calls, call => call.StartsWith("image remove"));
    }

    [Fact]
    public async Task An_unused_image_is_removed_without_pruning_its_parents()
    {
        var runner = Runner(
            ("image inspect", Ok("""[{"Id":"sha256:b5f7c88708770000"}]""")),
            ("image list", Ok("""
                {"Containers":"4","ID":"0ca930bba714","Repository":"iris-wt-pg","Tag":"latest"}
                {"Containers":"0","ID":"b5f7c8870877","Repository":"<none>","Tag":"<none>"}
                """)),
            ("image remove", Ok("")));

        var json = await Call(Service(runner), "object-remove", """{"kind":"image","name":"b5f7c8870877","confirmed":true}""");

        Assert.Equal(["image inspect --format json b5f7c8870877", "image list --format json", "image remove --no-prune b5f7c8870877"], runner.Calls);
        Assert.Equal("""{"message":"Removed image 'b5f7c8870877'."}""", json);
    }

    [Fact]
    public async Task A_volume_is_removed_without_force_so_wslc_refuses_one_in_use()
    {
        var runner = Runner(
            ("volume inspect", Ok("""[{"Name":"webdata"}]""")),
            ("volume remove", new CommandResult(1, "", "Volume 'webdata' is in use.\nError code: WSLC_E_VOLUME_IN_USE\n")));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Call(Service(runner), "object-remove", """{"kind":"volume","name":"webdata","confirmed":true}"""));

        Assert.Equal(["volume inspect --format json webdata", "volume remove webdata"], runner.Calls);
        Assert.Equal("Removing volume 'webdata' failed: Volume 'webdata' is in use. Error code: WSLC_E_VOLUME_IN_USE", error.Message);
    }

    [Fact]
    public async Task Network_membership_changes_name_the_network_then_the_container()
    {
        var runner = Runner(("network", Ok("")));
        var service = Service(runner);

        var connected = await Call(service, "network-connect", """{"network":"web-net","name":"web","confirmed":true}""");
        var disconnected = await Call(service, "network-connect", """{"network":"web-net","name":"web","disconnect":true,"confirmed":true}""");

        Assert.Equal(["network connect web-net web", "network disconnect web-net web"], runner.Calls);
        Assert.Equal("""{"message":"Connected 'web' to network 'web-net'."}""", connected);
        Assert.Equal("""{"message":"Disconnected 'web' from network 'web-net'."}""", disconnected);
    }

    [Fact]
    public async Task Copy_out_uses_native_cp_and_will_not_overwrite_unless_told()
    {
        var runner = Runner(("container cp", Ok("")));
        var target = Path.Combine(_temp, "nginx");
        string Request(bool overwrite) => JsonSerializer.Serialize(new { name = "web", containerPath = "/etc/nginx", hostPath = target, direction = "out", confirmed = true, overwrite });

        var json = await Call(Service(runner), "copy", Request(false));
        Directory.CreateDirectory(target);
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(Service(runner), "copy", Request(false)));
        await Call(Service(runner), "copy", Request(true));

        Assert.Equal([$"container cp --quiet web:/etc/nginx {target}", $"container cp --quiet web:/etc/nginx {target}"], runner.Calls);
        Assert.Equal(TimeSpan.FromMinutes(30), runner.Timeouts[0]);
        Assert.Equal($"Copied web:/etc/nginx to {target}.", JsonDocument.Parse(json).RootElement.GetProperty("message").GetString());
        Assert.Equal($"'{target}' already exists. Confirm overwriting it or choose another location.", refused.Message);
    }

    [Fact]
    public async Task Copy_out_directory_accepts_an_existing_drive_root_and_preserves_directory_semantics()
    {
        var runner = Runner(("container cp", Ok("")));
        var root = Path.GetPathRoot(_temp)!;
        var request = JsonSerializer.Serialize(new { name = "web", containerPath = "/data", hostPath = root, direction = "out", directory = true, confirmed = true, overwrite = true });

        await Call(Service(runner), "copy", request);

        Assert.Equal([$"container cp --quiet web:/data {root}"], runner.Calls);
    }

    [Fact]
    public async Task Copy_in_needs_an_existing_host_file()
    {
        var runner = Runner(("container cp", Ok("")));
        var source = Path.Combine(_temp, "site.conf");
        string Request() => JsonSerializer.Serialize(new { name = "web", containerPath = "/etc/nginx/conf.d/", hostPath = source, direction = "in", confirmed = true });

        await Assert.ThrowsAsync<ArgumentException>(() => Call(Service(runner), "copy", Request()));
        File.WriteAllText(source, "server {}");
        await Call(Service(runner), "copy", Request());

        Assert.Equal([$"container cp --quiet {source} web:/etc/nginx/conf.d/"], runner.Calls);
    }

    [Fact]
    public async Task Image_save_writes_one_archive_to_a_new_host_path()
    {
        var runner = Runner(("image save", Ok("")));
        var archive = Path.Combine(_temp, "nginx.tar");

        var json = await Call(Service(runner), "image-save", JsonSerializer.Serialize(new { name = "nginx:1.27", path = archive, confirmed = true }));

        Assert.Equal([$"image save --output {archive} nginx:1.27"], runner.Calls);
        Assert.Equal(TimeSpan.FromMinutes(30), runner.Timeouts[0]);
        Assert.Contains("Saved image 'nginx:1.27'", json);
    }

    [Fact]
    public async Task Volume_backup_refuses_a_running_container()
    {
        var runner = Runner(("volume inspect", Ok("""[{"Name":"webdata"}]""")), ("container inspect", Ok(WebInspect)));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(Service(runner), "volume-backup",
            JsonSerializer.Serialize(new { name = "webdata", path = Path.Combine(_temp, "backup"), container = "web", containerPath = "/data", confirmed = true })));

        Assert.Equal("Stop 'web' before backing up 'webdata'; copying files a running service writes can produce a broken backup.", error.Message);
        Assert.DoesNotContain(runner.Calls, call => call.StartsWith("container cp"));
    }

    [Fact]
    public async Task Volume_backup_refuses_a_container_that_mounts_it_elsewhere()
    {
        var stopped = WebInspect.Replace("\"Running\":true", "\"Running\":false").Replace("\"Status\":\"running\"", "\"Status\":\"exited\"");
        var runner = Runner(("volume inspect", Ok("""[{"Name":"webdata"}]""")), ("container inspect", Ok(stopped)));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(Service(runner), "volume-backup",
            JsonSerializer.Serialize(new { name = "webdata", path = Path.Combine(_temp, "backup"), container = "web", containerPath = "/var/lib/data", confirmed = true })));

        Assert.Equal("'web' does not mount volume 'webdata' at /var/lib/data.", error.Message);
        Assert.DoesNotContain(runner.Calls, call => call.StartsWith("container cp"));
    }

    [Fact]
    public async Task Volume_backup_copies_the_mount_out_of_a_stopped_container()
    {
        var stopped = WebInspect.Replace("\"Running\":true", "\"Running\":false").Replace("\"Status\":\"running\"", "\"Status\":\"exited\"");
        var runner = Runner(("volume inspect", Ok("""[{"Name":"webdata"}]""")), ("container inspect", Ok(stopped)), ("container list", Ok("")), ("container cp", Ok("")));
        var backup = Path.Combine(_temp, "backup");

        var json = await Call(Service(runner), "volume-backup",
            JsonSerializer.Serialize(new { name = "webdata", path = backup, container = "web", containerPath = "/data/", confirmed = true }));

        Assert.Equal(["volume inspect --format json webdata", "container inspect --format json web", "container list --all --format json", $"container cp --quiet web:/data {backup}{Path.DirectorySeparatorChar}"], runner.Calls);
        Assert.Contains("stopped container 'web'", json);
    }

    [Fact]
    public async Task Files_lists_a_directory_with_the_path_as_a_positional_argument()
    {
        IReadOnlyList<string>? seen = null;
        var runner = new FakeRunner(args => { seen = args; return Ok("D\nfile\tnginx.conf\0dir\tconf.d\0link\tmime\0dir\t.git\0"); });

        var json = await Call(Service(runner), "files", """{"name":"web","path":"/etc/nginx; reboot","confirmed":true}""");

        Assert.Equal(["container", "exec", "web", "sh", "-c", Management.FilesScript, "sh", "/etc/nginx; reboot"], seen);
        Assert.DoesNotContain("\r", Management.FilesScript);
        Assert.Equal(
            """{"path":"/etc/nginx; reboot","entries":[{"name":".git","type":"dir"},{"name":"conf.d","type":"dir"},{"name":"mime","type":"link"},{"name":"nginx.conf","type":"file"}],"truncated":false}""",
            json);
    }

    [Fact]
    public async Task Files_previews_a_text_file_and_explains_a_missing_shell()
    {
        var preview = await Call(Service(new FakeRunner(_ => Ok("F\nuser nginx;\n"))), "files", """{"name":"web","path":"/etc/nginx/nginx.conf","confirmed":true}""");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Call(Service(new FakeRunner(_ => new CommandResult(127, "", "exec: \"sh\": executable file not found in $PATH"))), "files", """{"name":"distroless","confirmed":true}"""));

        Assert.Equal("""{"path":"/etc/nginx/nginx.conf","entries":[],"text":"user nginx;\n","binary":false,"truncated":false}""", preview);
        Assert.Equal("'distroless' has no /bin/sh, so its files cannot be browsed. Use copy to transfer files instead.", error.Message);
    }

    [Fact]
    public async Task Runtime_reads_info_sessions_and_capabilities_once()
    {
        var runner = Runner(
            ("system info", Ok("""{"Client":{"SettingsFile":"C:\\Users\\me\\AppData\\Local\\wslc\\settings.yaml","Version":"3.0.3.0"},"Server":{"Sessions":[{"CreatorPid":199700,"ID":1,"Name":"wslc-cli-me"}]}}""")),
            ("system session list", Ok("ID        Creator PID   Display Name\n1         199700        wslc-cli-me\n")),
            ("--help", Ok("Commands:\n  container  Manage containers.\n  events     Monitor container events.\n")),
            ("container run --help", Ok("      --health-cmd           Command to run to check container health\n")));
        var service = Service(runner);

        var json = await Call(service, "runtime", "{}");
        await Call(service, "runtime", "{}");

        Assert.Equal(["system info --format json", "system session list", "--help", "container run --help", "system info --format json", "system session list"], runner.Calls);
        Assert.Equal(
            """{"info":{"Client":{"SettingsFile":"C:\\Users\\me\\AppData\\Local\\wslc\\settings.yaml","Version":"3.0.3.0"},"Server":{"Sessions":[{"CreatorPid":199700,"ID":1,"Name":"wslc-cli-me"}]}},"sessions":"ID        Creator PID   Display Name\n1         199700        wslc-cli-me","session":"","capabilities":{"events":true,"health":true,"compose":false},"settingsPath":"C:\\Users\\me\\AppData\\Local\\wslc\\settings.yaml"}""",
            json);
    }

    [Fact]
    public async Task Storage_lists_session_disks_without_descending_further()
    {
        var session = Directory.CreateDirectory(Path.Combine(_temp, "sessions", "wslc-cli-me")).FullName;
        File.WriteAllBytes(Path.Combine(session, "storage.vhdx"), new byte[1234]);
        File.WriteAllBytes(Path.Combine(session, "swap.vhdx"), new byte[10]);
        File.WriteAllBytes(Path.Combine(Directory.CreateDirectory(Path.Combine(session, "nested")).FullName, "deep.bin"), new byte[1]);
        var runner = Runner(("system info", Ok("""{"Server":{"Sessions":[{"Name":"other"},{"Name":"wslc-cli-me"}]}}""")));

        var result = JsonDocument.Parse(await Call(Service(runner), "storage", "{}")).RootElement;

        Assert.Equal(session, result.GetProperty("sessionFolder").GetString());
        Assert.Equal(
            $$"""[{"path":"{{Path.Combine(session, "storage.vhdx").Replace(@"\", @"\\")}}","bytes":1234},{"path":"{{Path.Combine(session, "swap.vhdx").Replace(@"\", @"\\")}}","bytes":10}]""",
            result.GetProperty("files").GetRawText());
        Assert.True(result.GetProperty("totalBytes").GetInt64() > 0);
        Assert.Equal(Management.StorageNote, result.GetProperty("note").GetString());
    }

    [Fact]
    public async Task Storage_does_not_label_shared_disks_as_an_unknown_active_session()
    {
        var root = Directory.CreateDirectory(Path.Combine(_temp, "sessions")).FullName;
        var other = Directory.CreateDirectory(Path.Combine(root, "other-session")).FullName;
        File.WriteAllBytes(Path.Combine(other, "storage.vhdx"), new byte[1234]);

        var result = JsonDocument.Parse(await Call(new Management(Runner(), "custom-session", root), "storage", "{}")).RootElement;

        Assert.Equal(JsonValueKind.Null, result.GetProperty("sessionFolder").ValueKind);
        Assert.Equal(root, result.GetProperty("storageRoot").GetString());
        Assert.Single(result.GetProperty("files").EnumerateArray());
    }

    [Fact]
    public async Task Storage_says_so_when_wslc_has_no_disks_yet()
    {
        var result = JsonDocument.Parse(await Call(new Management(Runner(), "named", Path.Combine(_temp, "absent")), "storage", "{}")).RootElement;

        Assert.Equal("[]", result.GetProperty("files").GetRawText());
        Assert.StartsWith($"No WSLc storage was found at {Path.Combine(_temp, "absent")}.", result.GetProperty("note").GetString());
    }

    [Fact]
    public async Task Events_are_a_bounded_window_ending_now()
    {
        var runner = Runner(("system events", Ok("""
            {"Action":"die","Actor":{"Attributes":{"exitCode":"137","name":"web","db_password":"hunter2"}},"Type":"container","time":1792181515}
            """)));
        var service = new Management(runner, "", _temp) { Clock = new FixedClock(DateTimeOffset.FromUnixTimeSeconds(1792185000)) };

        var latest = await Call(service, "events", """{"since":"1792181000"}""");
        await Call(service, "events", "{}");

        Assert.Equal([
            "system events --format json --since 1792181000 --until 1792185000",
            "system events --format json --since 1792181400 --until 1792185000",
        ], runner.Calls);
        Assert.Equal(
            """{"entries":[{"Action":"die","Actor":{"Attributes":{"exitCode":"137","name":"web","db_password":"••••"}},"Type":"container","time":1792181515}],"since":"1792181000","until":"1792185000"}""",
            latest);
    }

    [Fact]
    public async Task Events_that_overflow_the_output_limit_fail_so_the_gap_is_visible()
    {
        var runner = Runner(("system events", new CommandResult(0, "{\"Action\":\"start\"}\n", "", Truncated: true)));
        var service = new Management(runner, "", _temp) { Clock = new FixedClock(DateTimeOffset.FromUnixTimeSeconds(1792185000)) };

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(service, "events", """{"since":"1792181000"}"""));

        Assert.Equal("Runtime events from 1792181000 to 1792185000 exceeded the output limit, so some were not read.", error.Message);
    }

    [Fact]
    public async Task Diagnose_finds_the_windows_owner_and_connects_without_wslc()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var runner = Runner();

            var result = JsonDocument.Parse(await Call(Service(runner), "diagnose", $$"""{"host":"127.0.0.1","port":{{port}},"confirmed":true}""")).RootElement;

            var checks = result.GetProperty("checks").EnumerateArray().ToList();
            Assert.Equal(["Windows listener", "Host TCP"], checks.Select(c => c.GetProperty("name").GetString()));
            Assert.All(checks, c => Assert.True(c.GetProperty("ok").GetBoolean(), c.GetProperty("detail").GetString()));
            Assert.Contains($"127.0.0.1:{port} ", checks[0].GetProperty("detail").GetString());
            Assert.Contains($"(pid {Environment.ProcessId})", checks[0].GetProperty("detail").GetString());
            Assert.Empty(runner.Calls);
        }
        finally
        {
            listener.Stop();
        }
    }

    // VULN-001/008 — probing a restricted destination without confirmation is refused before connecting.
    [Fact]
    public async Task Diagnose_to_loopback_needs_confirmation()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Call(Service(Runner()), "diagnose", """{"host":"127.0.0.1","port":1}"""));

        Assert.Contains("needs explicit confirmation", error.Message);
    }

    [Fact]
    public async Task Diagnose_probes_from_inside_the_container_with_positional_destinations()
    {
        var calls = new List<IReadOnlyList<string>>();
        var runner = new FakeRunner(args =>
        {
            calls.Add(args);
            return args[1] == "inspect" ? Ok(WebInspect)
                : args.Last() == "5432" ? new CommandResult(1, "", "nc: db (172.17.0.4:5432): Connection refused")
                : Ok("172.17.0.4      db\n");
        });

        var result = JsonDocument.Parse(await Call(Service(runner), "diagnose",
            """{"name":"web","host":"127.0.0.1","port":1,"probeHost":"db","probePort":5432,"confirmed":true}""")).RootElement;

        var checks = result.GetProperty("checks").EnumerateArray().ToDictionary(c => c.GetProperty("name").GetString()!, c => (c.GetProperty("ok").GetBoolean(), c.GetProperty("detail").GetString()));
        Assert.Equal((false, "'web' does not publish host port 1; its ports are {\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"8080\"}]}."), checks["Published port"]);
        Assert.Equal((true, "db: 172.17.0.4      db"), checks["Container DNS"]);
        Assert.Equal((false, "Container TCP probe of db:5432 from 'web' failed: nc: db (172.17.0.4:5432): Connection refused"), checks["Container TCP"]);
        Assert.Equal(["container", "exec", "web", "sh", "-c"], calls[1].Take(5));
        Assert.Equal(["sh", "db"], calls[1].Skip(6));
        Assert.Equal(["sh", "db", "5432"], calls[2].Skip(6));
    }

    [Fact]
    public void Several_listeners_report_bindings_without_claiming_a_port_conflict()
    {
        var check = Management.ListenerCheck(8080, [new Listener("0.0.0.0", 8080, 10, "wslrelay"), new Listener("127.0.0.1", 8080, 20, "node")]);

        Assert.Equal(new Check("Windows listener", true, "Multiple listeners on TCP port 8080: 0.0.0.0:8080 wslrelay (pid 10); 127.0.0.1:8080 node (pid 20). Check which address your client uses; these bindings alone do not prove a port conflict."), check);
    }

    [Fact]
    public void Published_ports_accept_numeric_fields_without_matching_container_ports()
    {
        Assert.True(Management.HasPublishedPort(System.Text.Json.Nodes.JsonNode.Parse("""{"80/tcp":[{"HostPort":8080}]}"""), 8080));
        Assert.False(Management.HasPublishedPort(System.Text.Json.Nodes.JsonNode.Parse("""{"80/tcp":[{"HostPort":"8080"}]}"""), 80));
    }

    [Fact]
    public async Task Volume_backup_refuses_a_different_running_writer()
    {
        var stopped = WebInspect.Replace("\"Running\":true", "\"Running\":false").Replace("\"Status\":\"running\"", "\"Status\":\"exited\"");
        var runner = new FakeRunner(args => args[0] == "volume" ? Ok("""[{"Name":"webdata"}]""")
            : args[1] == "list" ? Ok("""{"Names":"writer","State":"running"}""")
            : args.Last() == "web" ? Ok(stopped) : Ok(WebInspect.Replace("\"/web\"", "\"/writer\"")));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Call(Service(runner), "volume-backup",
            JsonSerializer.Serialize(new { name = "webdata", path = Path.Combine(_temp, "backup"), container = "web", containerPath = "/data", confirmed = true })));
        Assert.Equal("Stop 'writer' before backing up 'webdata'; it also writes this volume.", error.Message);
        Assert.DoesNotContain(runner.Calls, call => call.StartsWith("container cp", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Cancellation_reaches_the_runner()
    {
        var runner = Runner(("container inspect", Ok(WebInspect)));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new Management(runner, "", _temp).HandleAsync("inspect", JsonDocument.Parse("""{"name":"web"}""").RootElement, cancelled.Token));

        Assert.True(runner.LastToken.IsCancellationRequested);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_or_cancelled_exports_identify_partial_output_and_dispatch(bool cancel)
    {
        var path = Path.Combine(_temp, "image.tar");
        var runner = new FakeRunner(_ => cancel ? throw new OperationCanceledException() : new CommandResult(1, "", "Disk full."));
        var service = Service(runner);
        var parameters = JsonSerializer.Serialize(new { name = "web", path, confirmed = true });
        var error = await Record.ExceptionAsync(() => Call(service, "image-save", parameters));
        Assert.NotNull(error);
        Assert.Contains("A partial copy may remain at " + path, error.Message);
        Assert.Equal(path, error.Data["partialOutput"]);
        Assert.Equal(true, error.Data["actionSent"]);
        Assert.Equal(cancel, error is OperationCanceledException);
    }
}
