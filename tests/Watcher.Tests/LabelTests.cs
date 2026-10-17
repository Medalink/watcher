using System.IO;
using System.Text.Json;

namespace Watcher.Tests;

public sealed class LabelTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("watcher-test-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private const string Metadata = """com.microsoft.wsl.container.metadata={"V1":{"Flags":0,"Ports":[{"HostPort":8080}],"Volumes":[]}}""";

    private static JsonElement Row(string labels) => JsonSerializer.SerializeToElement(new Dictionary<string, string>
    {
        ["CreatedAt"] = "2026-10-16 12:00:43 -0500 CDT", ["Image"] = "nginx:1.27", ["Labels"] = labels, ["Names"] = "web-app", ["Ports"] = "127.0.0.1:8080->80/tcp",
        ["State"] = "running", ["Status"] = "Up About an hour",
    });

    [Fact]
    public void Settings_fall_back_to_the_default_per_key()
    {
        Assert.Equal((string[])["watcher.path"], Settings.Default.PathLabels);
        Assert.Equal((string[])["watcher.group", "com.docker.compose.project"], Settings.Default.GroupLabels);

        var custom = Settings.Parse("""{ "pathLabels": ["dev.folder", "watcher.path"] }""");
        Assert.Equal((string[])["dev.folder", "watcher.path"], custom.PathLabels);
        Assert.Equal(Settings.Default.GroupLabels, custom.GroupLabels);

        var wrongTypes = Settings.Parse("""{ "pathLabels": "dev.folder", "groupLabels": ["team", 3] }""");
        Assert.Equal((Settings.Default.PathLabels, Settings.Default.GroupLabels), (wrongTypes.PathLabels, wrongTypes.GroupLabels));

        Assert.Same(Settings.Default, Settings.Parse("{ not json"));
        Assert.Equal(Settings.Default.PathLabels, Settings.Parse("[]").PathLabels);
        Assert.Same(Settings.Default, Settings.Load(Path.Combine(_root, "missing.json")));
    }

    [Fact]
    public void Labels_match_whole_keys_after_the_metadata_value()
    {
        var labels = $"{Metadata},old.watcher.path=C:/elsewhere,watcher.path=C:/src/shop/main,com.docker.compose.project=shop";

        Assert.Equal("C:/src/shop/main", Wslc.Label(labels, "watcher.path"));
        Assert.Equal("shop", Wslc.Label(labels, "com.docker.compose.project"));
        Assert.Null(Wslc.Label(labels, "com.docker"));
        Assert.Null(Wslc.Label("comXdockerXcompose.project=shop", "com.docker.compose.project"));
    }

    [Fact]
    public void Describe_reads_the_folder_branch_group_and_orphan_from_labels()
    {
        var main = Directory.CreateDirectory(Path.Combine(_root, "shop", "main")).FullName;
        Directory.CreateDirectory(Path.Combine(main, ".git"));
        File.WriteAllText(Path.Combine(main, ".git", "HEAD"), "ref: refs/heads/feature/cart\n");
        var deleted = Path.Combine(_root, "shop", "old") + "/";

        var live = Monitor.Describe("web-app", Row($"{Metadata},watcher.path={main},watcher.group=Storefront"), Settings.Default);
        var orphan = Monitor.Describe("api-db", Row($"watcher.path={deleted},com.docker.compose.project=shop"), Settings.Default);
        var plain = Monitor.Describe("cache", Row(Metadata), Settings.Default);

        Assert.Equal(new ContainerInfo("web-app", "main", main, "Storefront", "feature/cart", "nginx:1.27", "running", false, "8080", "1 hour", 1_792_170_043_000), live);
        Assert.Equal(new ContainerInfo("api-db", "old", deleted, "shop", null, "nginx:1.27", "running", true, "8080", "1 hour", 1_792_170_043_000), orphan);
        Assert.Equal(new ContainerInfo("cache", "cache", null, null, null, "nginx:1.27", "running", false, "8080", "1 hour", 1_792_170_043_000), plain);
        Assert.False(plain.HasPath);
    }

    [Fact]
    public void A_relative_path_label_is_never_orphaned_so_Reap_cannot_remove_it()
    {
        var relative = Monitor.Describe("web-app", Row("watcher.path=./missing-app"), Settings.Default);

        Assert.Equal(("missing-app", "./missing-app", false), (relative.Title, relative.Path, relative.Orphan));
    }

    [Fact]
    public void Created_at_keeps_the_offset_and_ignores_the_zone_name()
    {
        Assert.Equal(1_792_170_043_000, Wslc.Created("2026-10-16 12:00:43 -0500 CDT"));
        Assert.Equal(1_792_170_043_000, Wslc.Created("2026-10-16 22:30:43 +0530 IST"));
        Assert.Equal(1_792_170_043_000, Wslc.Created("2026-10-16 17:00:43 +0000 UTC"));
        Assert.Null(Wslc.Created(""));
        Assert.Null(Wslc.Created("yesterday"));
    }

    [Fact]
    public void Wslc_is_found_on_the_search_path_before_the_install_folder()
    {
        var empty = Directory.CreateDirectory(Path.Combine(_root, "empty")).FullName;
        var onPath = Directory.CreateDirectory(Path.Combine(_root, "bin")).FullName;
        var programFiles = Directory.CreateDirectory(Path.Combine(_root, "Program Files", "WSL")).Parent!.FullName;
        File.WriteAllText(Path.Combine(onPath, "wslc.exe"), "");

        Assert.Equal(Path.Combine(onPath, "wslc.exe"), Wslc.Find($"{empty};\"{onPath}\"", programFiles));
        Assert.Null(Wslc.Find(empty, programFiles));

        File.WriteAllText(Path.Combine(programFiles, "WSL", "wslc.exe"), "");
        Assert.Equal(Path.Combine(programFiles, "WSL", "wslc.exe"), Wslc.Find(empty, programFiles));
        Assert.Equal(Path.Combine(programFiles, "WSL", "wslc.exe"), Wslc.Find(null, programFiles));
    }
}
