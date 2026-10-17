using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace Watcher;

/// <summary>
/// Guards renderer-supplied network destinations. Loopback, private, link-local and unique-local
/// targets are restricted: probing them is the diagnose feature's job, but it must be an explicit,
/// confirmed action rather than a silent primitive. Destinations are also resolved once and pinned,
/// so a lookup cannot answer with a public address and connect to a private one (DNS rebinding).
/// </summary>
public static class NetworkGuard
{
    /// <summary>True when any resolved address is in a restricted range.</summary>
    public static bool IsRestricted(IReadOnlyList<IPAddress> addresses) => addresses.Any(Restricted);

    public static bool Restricted(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) return RestrictedV4(address.MapToIPv4());
        return address.AddressFamily switch
        {
            AddressFamily.InterNetwork => RestrictedV4(address),
            AddressFamily.InterNetworkV6 => address.Equals(IPAddress.IPv6Loopback) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || UniqueLocal(address),
            _ => false,
        };
    }

    private static bool UniqueLocal(IPAddress address) =>
        address.GetAddressBytes() is [var first, ..] && (first & 0xFE) == 0xFC;

    private static bool RestrictedV4(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes.Length == 4 && (
            bytes[0] is 0 or 10 or 127
            || bytes[0] == 100 && bytes[1] is >= 64 and <= 127
            || bytes[0] == 169 && bytes[1] == 254
            || bytes[0] == 172 && bytes[1] is >= 16 and <= 31
            || bytes[0] == 192 && bytes[1] == 168);
    }

    /// <summary>Literal IPs pass through; names resolve. Empty when nothing resolves (the connect attempt then fails on its own).</summary>
    public static async Task<IPAddress[]> ResolveAsync(string host, CancellationToken token)
    {
        if (IPAddress.TryParse(host, out var literal)) return [literal];
        try
        {
            return await Dns.GetHostAddressesAsync(host, token);
        }
        catch (SocketException)
        {
            return [];
        }
    }

    /// <summary>
    /// A connect callback that re-resolves and refuses restricted addresses unless they were confirmed,
    /// so the address validated at confirm time is the address connected to.
    /// </summary>
    public static Func<SocketsHttpConnectionContext, CancellationToken, ValueTask<Stream>> ValidatingConnect(string host, bool allowRestricted) =>
        async (context, token) =>
        {
            var addresses = await ResolveAsync(host, token);
            if (addresses.Length == 0) throw new ArgumentException($"'{host}' could not be resolved.");
            if (!allowRestricted && addresses.Any(Restricted))
                throw new InvalidOperationException($"'{host}' resolved to a private or loopback address; probing it needs explicit confirmation.");
            Exception? failure = null;
            foreach (var address in addresses)
            {
                var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), token);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (Exception e) when (e is SocketException or OperationCanceledException)
                {
                    failure ??= e;
                    socket.Dispose();
                    if (e is OperationCanceledException) throw;
                }
            }
            throw failure ?? new InvalidOperationException($"'{host}' could not be connected.");
        };
}
