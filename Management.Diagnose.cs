using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Watcher;

public sealed record Check(string Name, bool Ok, string Detail);

public sealed record Listener(string Address, int Port, int Pid, string Process);

/// <summary>Why a published port does not answer: who owns it on Windows, whether it connects, and what the container sees.</summary>
public sealed partial class Management
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(3);

    private const string DnsProbe = """
        if command -v getent >/dev/null 2>&1; then getent hosts "$1"
        elif command -v nslookup >/dev/null 2>&1; then nslookup "$1"
        else echo "Neither getent nor nslookup is installed in the container." >&2; exit 127
        fi
        """;

    private const string TcpProbe = """
        if command -v nc >/dev/null 2>&1; then nc -z -w 3 "$1" "$2"
        elif command -v bash >/dev/null 2>&1; then timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2"
        else echo "Neither nc nor bash is installed in the container." >&2; exit 127
        fi
        """;

    /// <summary>Checks run one after another, each with its own short timeout, against destinations the user typed.</summary>
    private async Task<object> DiagnoseAsync(Parameters p, CancellationToken token)
    {
        var host = Host(p.Text("host", "localhost"), "host");
        var port = p.Number("port", 0, 1, 65535);
        if (port == 0) throw new ArgumentException("port is required.");
        var name = p.Text("name") is { Length: > 0 } ? p.Identifier("name") : null;
        var probeHost = p.Text("probeHost") is { Length: > 0 } given ? Host(given, "probeHost") : null;
        var probePort = p.Number("probePort", 0, 1, 65535);

        var listeners = TcpListeners.On(port);
        var checks = new List<Check> { ListenerCheck(port, listeners) };
        // Windows-side probes may only reach private or loopback destinations with explicit confirmation,
        // and the resolved address set is pinned so a lookup cannot answer public and connect private.
        var resolved = await NetworkGuard.ResolveAsync(host, token);
        var restricted = NetworkGuard.IsRestricted(resolved);
        if (restricted) p.Confirm($"Probing '{host}', which resolves to a private or loopback address");
        object? published = null;
        if (name is not null)
        {
            var detail = Inspection.Detail(await InspectAsync("container", name, token));
            published = detail.Ports;
            var bound = HasPublishedPort(detail.Ports, port);
            checks.Add(new Check("Published port", bound, bound
                ? $"'{name}' publishes container traffic on host port {port}."
                : $"'{name}' does not publish host port {port}; its ports are {detail.Ports?.ToJsonString() ?? "none"}."));
        }
        checks.Add(await TcpCheckAsync(host, port, restricted, token));
        if (p.Flag("http"))
        {
            checks.Add(await HttpCheckAsync(host, port, restricted, token));
        }
        if (name is not null && probeHost is not null)
        {
            checks.Add(await ProbeAsync("Container DNS", name, DnsProbe, [probeHost], token));
            if (probePort > 0)
            {
                checks.Add(await ProbeAsync("Container TCP", name, TcpProbe, [probeHost, probePort.ToString()], token));
            }
        }
        return new { checks, ports = listeners, published };
    }

    private static string Host(string host, string key) =>
        HostPattern().IsMatch(host) ? host : throw new ArgumentException($"{key} must be a host name or IP address.");

    [GeneratedRegex(@"^(?!-)[A-Za-z0-9._:%\[\]-]{1,253}$")]
    private static partial Regex HostPattern();

    public static bool HasPublishedPort(System.Text.Json.Nodes.JsonNode? node, int port)
    {
        if (node is System.Text.Json.Nodes.JsonObject obj)
        {
            return obj.Any(pair => pair.Key.Equals("HostPort", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(pair.Value?.ToString(), out var value) && value == port || HasPublishedPort(pair.Value, port));
        }
        return node is System.Text.Json.Nodes.JsonArray array && array.Any(value => HasPublishedPort(value, port));
    }

    public static Check ListenerCheck(int port, IReadOnlyList<Listener> listeners)
    {
        if (listeners.Count == 0)
        {
            return new Check("Windows listener", false, $"Nothing on Windows is listening on TCP port {port}.");
        }
        var owners = string.Join("; ", listeners.Select(l => $"{l.Address}:{l.Port} {l.Process} (pid {l.Pid})"));
        return listeners.Select(l => l.Pid).Distinct().Count() > 1
            ? new Check("Windows listener", true, $"Multiple listeners on TCP port {port}: {owners}. Check which address your client uses; these bindings alone do not prove a port conflict.")
            : new Check("Windows listener", true, $"Listening: {owners}.");
    }

    private static async Task<Check> TcpCheckAsync(string host, int port, bool allowRestricted, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(ProbeTimeout);
        var watch = Stopwatch.StartNew();
        try
        {
            var addresses = await NetworkGuard.ResolveAsync(host, deadline.Token);
            if (addresses.Length == 0) return new Check("Host TCP", false, $"{host}: could not be resolved.");
            if (!allowRestricted && addresses.Any(NetworkGuard.Restricted))
                return new Check("Host TCP", false, $"{host} resolves to a private or loopback address; probing it needs explicit confirmation.");
            SocketException? last = null;
            foreach (var address in addresses)
            {
                using var client = new TcpClient(address.AddressFamily);
                try
                {
                    await client.ConnectAsync(address, port, deadline.Token);
                    return new Check("Host TCP", true, $"Connected to {host}:{port} in {watch.ElapsedMilliseconds} ms.");
                }
                catch (SocketException e) { last = e; }
            }
            return new Check("Host TCP", false, $"{host}:{port}: {last?.Message ?? "no resolved address answered"}.");
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            return new Check("Host TCP", false, $"No answer from {host}:{port} within {ProbeTimeout.TotalSeconds:0} seconds.");
        }
    }

    private static async Task<Check> HttpCheckAsync(string host, int port, bool allowRestricted, CancellationToken token)
    {
        using var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false };
        handler.ConnectCallback = NetworkGuard.ValidatingConnect(host, allowRestricted);
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        var url = new UriBuilder("http", host, port).Uri;
        try
        {
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
            var code = (int)response.StatusCode;
            return new Check("HTTP", code < 500, $"GET {url} answered {code} {response.ReasonPhrase}.");
        }
        catch (TaskCanceledException) when (!token.IsCancellationRequested)
        {
            return new Check("HTTP", false, $"GET {url} did not answer within 5 seconds.");
        }
        catch (HttpRequestException e)
        {
            return new Check("HTTP", false, $"GET {url} failed: {e.Message}");
        }
    }

    /// <summary>Destinations reach the shell as positional arguments, never inside the script.</summary>
    private async Task<Check> ProbeAsync(string check, string name, string script, string[] destination, CancellationToken token)
    {
        var result = await runner.RunAsync(["container", "exec", name, "sh", "-c", script.ReplaceLineEndings("\n"), "sh", .. destination], token, TimeSpan.FromSeconds(15));
        var target = string.Join(":", destination);
        return result.Code == 0
            ? new Check(check, true, $"{target}: {result.Output.Trim().Split('\n')[0].Trim()}".TrimEnd(' ', ':'))
            : new Check(check, false, Inspection.Failure(result, $"{check} probe of {target} from '{name}'"));
    }

    /// <summary>Listening TCP sockets with their owning process, from the Windows IP helper table.</summary>
    private static class TcpListeners
    {
        private const int OwnerPidListener = 3;
        private const uint InsufficientBuffer = 122;

        [DllImport("iphlpapi.dll")]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

        public static List<Listener> On(int port) =>
            Read(AddressFamily.InterNetwork).Concat(Read(AddressFamily.InterNetworkV6)).Where(l => l.Port == port).ToList();

        private static List<Listener> Read(AddressFamily family)
        {
            var v4 = family == AddressFamily.InterNetwork;
            // MIB_TCPROW_OWNER_PID is 24 bytes, MIB_TCP6ROW_OWNER_PID 56; both follow a 4-byte row count.
            var (rowSize, portOffset, pidOffset) = v4 ? (24, 8, 20) : (56, 20, 52);
            var size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, (int)family, OwnerPidListener, 0);
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var buffer = Marshal.AllocHGlobal(size);
                try
                {
                    var status = GetExtendedTcpTable(buffer, ref size, false, (int)family, OwnerPidListener, 0);
                    if (status == InsufficientBuffer) continue;
                    if (status != 0) return [];
                    var rows = new List<Listener>();
                    for (var i = 0; i < Marshal.ReadInt32(buffer); i++)
                    {
                        var row = buffer + 4 + i * rowSize;
                        var address = v4 ? new IPAddress((uint)Marshal.ReadInt32(row, 4)) : new IPAddress(Bytes(row, 16));
                        var raw = Marshal.ReadInt32(row, portOffset);
                        var pid = Marshal.ReadInt32(row, pidOffset);
                        rows.Add(new Listener(address.ToString(), (raw & 0xFF) << 8 | (raw >> 8) & 0xFF, pid, ProcessName(pid)));
                    }
                    return rows;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            return [];
        }

        private static byte[] Bytes(IntPtr at, int count)
        {
            var bytes = new byte[count];
            Marshal.Copy(at, bytes, 0, count);
            return bytes;
        }

        private static string ProcessName(int pid)
        {
            try
            {
                using var process = System.Diagnostics.Process.GetProcessById(pid);
                return process.ProcessName;
            }
            catch (Exception e) when (e is ArgumentException or InvalidOperationException)
            {
                return "unknown";
            }
        }
    }
}
