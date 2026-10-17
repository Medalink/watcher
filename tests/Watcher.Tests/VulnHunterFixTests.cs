using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Watcher.Tests.Build;

namespace Watcher.Tests;

/// <summary>Regression tests for the VulnHunter findings fixed on this branch (VULN-003, VULN-004, VULN-007, VULN-008).</summary>
public sealed class VulnHunterFixTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // VULN-004 — the secret-key regex must cover authorization and signature keys, not just auth.
    [Fact]
    public void Masked_covers_authorization_and_signature_keys()
    {
        var node = JsonNode.Parse("""{"myapp.authorization":"hunter2","x-signature":"sigvalue","author":"kept","designer":"kept"}""")!;
        var text = Inspection.Masked(node)!.ToJsonString();

        Assert.DoesNotContain("hunter2", text);
        Assert.DoesNotContain("sigvalue", text);
        Assert.Contains("kept", text);
    }

    // VULN-003 — command-style arrays (Cmd/Entrypoint/Healthcheck) must not leak bearer tokens,
    // and Detail.Command is built from the masked node.
    [Fact]
    public void Masked_masks_bearer_tokens_in_command_arrays_and_detail()
    {
        var inspect = (JsonObject)JsonNode.Parse(
            """{"Name":"/web","Config":{"Cmd":["serve","--token","abc123def456"],"Entrypoint":["sh","-c","Authorization: Bearer xyz98765"]}}""")!;

        var detail = Inspection.Detail(inspect);

        var raw = detail.Raw.ToJsonString();
        Assert.DoesNotContain("abc123def456", raw);
        Assert.DoesNotContain("xyz98765", raw);
        Assert.DoesNotContain("abc123def456", string.Join(" ", detail.Command));
        Assert.DoesNotContain("xyz98765", string.Join(" ", detail.Command));
    }

    // VULN-007 — file text is masked before it reaches the renderer.
    [Fact]
    public void ParseFiles_masks_secret_lines()
    {
        var result = Management.ParseFiles("/etc/env", "F\nDB_PASSWORD=hunter2\nAuthorization: Bearer abc123\nplain line\n");

        var json = JsonSerializer.Serialize(result, Json);
        Assert.DoesNotContain("hunter2", json);
        Assert.DoesNotContain("abc123", json);
        Assert.Contains("plain line", json);
    }

    // VULN-008 — the shared guard marks private ranges restricted and public ones not.
    [Fact]
    public void NetworkGuard_marks_private_ranges_restricted_and_public_ones_not()
    {
        Assert.True(NetworkGuard.Restricted(IPAddress.Loopback));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("10.1.2.3")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("172.16.0.1")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("172.31.255.255")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("192.168.1.1")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("169.254.1.1")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("100.64.0.1")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("::1")));
        Assert.True(NetworkGuard.Restricted(IPAddress.Parse("fd00::1")));
        Assert.False(NetworkGuard.Restricted(IPAddress.Parse("8.8.8.8")));
        Assert.False(NetworkGuard.Restricted(IPAddress.Parse("172.32.0.1")));
    }
}
