using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Watcher;

/// <summary>What a machine offers containers: logical processors and memory in bytes.</summary>
public sealed partial record Capacity(int Cpus, double MemoryBytes)
{
    /// <summary>One process in a container prints the VM's processor count, then its MemTotal line.</summary>
    public const string ProbeScript = "grep -c ^processor /proc/cpuinfo; grep MemTotal /proc/meminfo";

    /// <summary>This Windows machine: every logical processor and the physical memory Windows can use.</summary>
    public static Capacity Windows()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };

        return new Capacity(Environment.ProcessorCount, GlobalMemoryStatusEx(ref status) ? status.TotalPhys : 0);
    }

    /// <summary>"32\nMemTotal:       48125120 kB" to 32 processors and 45.9 GiB; anything else is null.</summary>
    public static Capacity? Parse(string output)
    {
        var lines = output.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var memory = lines.Select(line => MemTotal().Match(line)).FirstOrDefault(match => match.Success);

        return lines.Length > 0 && int.TryParse(lines[0], out var cpus) && cpus > 0
            && memory is not null && long.TryParse(memory.Groups[1].Value, out var kib) && kib > 0
                ? new Capacity(cpus, kib * 1024d)
                : null;
    }

    /// <summary>The wslc VM's size, from the first running container that can run sh; a distroless image cannot.</summary>
    public static async Task<Capacity?> ProbeAsync(IEnumerable<string> running)
    {
        foreach (var name in running)
        {
            var (code, output) = await Wslc.Run("exec", name, "sh", "-c", ProbeScript);
            if (code == 0 && Parse(output) is { } capacity)
            {
                return capacity;
            }
        }

        return null;
    }

    [GeneratedRegex(@"^MemTotal:\s*(\d+)\s*kB$")]
    private static partial Regex MemTotal();

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx status);
}

/// <summary>
/// The two sizes the page compares against. Until a probe answers, WSL's size is unknown and Windows' stands in,
/// with <paramref name="WslMeasured"/> false.
/// </summary>
public sealed record Capacities(Capacity Wsl, Capacity Windows, bool WslMeasured)
{
    public static Capacities Unmeasured(Capacity windows) => new(windows, windows, WslMeasured: false);

    public Capacities Measured(Capacity wsl) => this with { Wsl = wsl, WslMeasured = true };
}
