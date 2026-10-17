using System.Globalization;
using System.Text;

namespace Watcher;

/// <summary>A Markdown report of one range, written for an AI to compare periods.</summary>
public static class Report
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    public static string Markdown(string range, StatsResult stats, IReadOnlyList<StoredEvent> events, DateTimeOffset generated, TimeZoneInfo zone)
    {
        string Time(long at) => TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(at), zone).ToString("yyyy-MM-dd HH:mm:ss", Invariant);
        string At(long? at) => at is { } value ? $" at {Time(value)}" : "";
        var offset = zone.GetUtcOffset(generated);
        var bucket = Duration(stats.BucketMs);
        var (wsl, windows) = (stats.Capacity.Wsl, stats.Capacity.Windows);
        // Unmeasured, WSL's size is Windows' stand-in, so the report names only Windows rather than claim a WSL share.
        (string Name, Capacity Size)[] bases = stats.Capacity.WslMeasured ? [("WSL", wsl), ("Windows", windows)] : [("Windows", windows)];
        string Shares(double value, Func<Capacity, double> total)
        {
            var shares = bases.Select(b => $"{Percent(Share(value, total(b.Size)))} of {b.Name}").ToList();
            return shares.Count == 1 ? shares[0] : $"{shares[0]} ({shares[1]})";
        }
        string Cpu(double cores) => Percent(Share(cores, bases[0].Size.Cpus));
        var text = new StringBuilder();

        text.AppendLine($"# Watcher report: last {range}").AppendLine();
        text.AppendLine($"- Range: {Time(stats.From)} to {Time(stats.To)} (local time, UTC{(offset < TimeSpan.Zero ? "-" : "+")}{offset:hh\\:mm})");
        text.AppendLine($"- Generated: {Time(generated.ToUnixTimeMilliseconds())}");
        text.AppendLine(stats.Capacity.WslMeasured
            ? $"- Source: wslc containers watched by Watcher. CPU is a share of WSL's {wsl.Cpus} processors (Windows has {windows.Cpus}). Memory percentages are of WSL's {Bytes(wsl.MemoryBytes)} (Windows has {Bytes(windows.MemoryBytes)})."
            : $"- Source: wslc containers watched by Watcher. WSL's size was not measured yet, so CPU is a share of Windows' {windows.Cpus} processors and memory percentages are of Windows' {Bytes(windows.MemoryBytes)}.");
        text.AppendLine($"- Totals are the sum over containers of each container's average in a {bucket} bucket.").AppendLine();

        text.AppendLine("## Totals and peaks").AppendLine();
        text.AppendLine($"- Peak total CPU: {Shares(stats.Peaks.Cpu, c => c.Cpus)}{At(stats.Peaks.CpuAt)}");
        text.AppendLine($"- Peak total memory: {Bytes(stats.Peaks.Memory)}, {Shares(stats.Peaks.Memory, c => c.MemoryBytes)}{At(stats.Peaks.MemoryAt)}");
        var running = stats.Series.Count == 0 ? 0 : stats.Series.Average(p => p.Running);
        text.AppendLine($"- Average running containers: {running.ToString("0.0", Invariant)}");
        text.AppendLine($"- Containers with data: {stats.Containers.Count}");
        text.AppendLine($"- Events: {events.Count}{(stats.Events.Count == 0 ? "" : $" ({string.Join(", ", stats.Events.OrderByDescending(e => e.Value).Select(e => $"{e.Key} {e.Value}"))})")}");
        text.AppendLine();

        text.AppendLine("## Containers").AppendLine();
        if (stats.Containers.Count == 0)
        {
            text.AppendLine("No samples in this range.");
        }
        else
        {
            text.AppendLine($"| Container | Samples | CPU avg | CPU p95 of {bucket} buckets | CPU max | Mem avg | Mem max | Mem limit | Net in | Net out | Disk read | Disk write | Uptime (share of watched time running) | Restarts |");
            text.AppendLine("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
            foreach (var c in stats.Containers)
            {
                text.AppendLine(string.Join(" | ", [
                    $"| {c.Title}{(c.Title == c.Name ? "" : $" ({c.Name})")}", c.Samples.ToString(Invariant),
                    Cpu(c.CpuAvg), Cpu(c.CpuP95), Cpu(c.CpuMax),
                    Bytes(c.MemAvg), Bytes(c.MemMax), Bytes(c.MemLimit),
                    Bytes(c.NetIn), Bytes(c.NetOut), Bytes(c.DiskRead), Bytes(c.DiskWrite),
                    Percent(c.UptimePct), $"{c.Restarts} |",
                ]));
            }
        }
        text.AppendLine();

        text.AppendLine("## Event log").AppendLine();
        if (events.Count == 0)
        {
            text.AppendLine("No events in this range.");
        }
        else
        {
            text.AppendLine("```text");
            foreach (var e in events)
            {
                text.AppendLine($"{Time(e.At)}  {e.Kind}  {e.Title ?? e.Container ?? "-"}  {e.Summary}");
            }
            text.AppendLine("```");
        }

        return text.ToString();
    }

    public static string Bytes(double value)
    {
        if (value <= 0)
        {
            return "0 B";
        }
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        var power = Math.Min(units.Length - 1, (int)Math.Floor(Math.Log(value, 1024)));
        var scaled = value / Math.Pow(1024, power);

        return $"{scaled.ToString(power == 0 || scaled >= 100 ? "0" : "0.0", Invariant)} {units[power]}";
    }

    private static double Share(double value, double total) => total > 0 ? value / total * 100 : 0;

    private static string Percent(double value) => $"{value.ToString(value >= 10 ? "0" : "0.0", Invariant)} %";

    private static string Duration(long ms) => ms >= 3_600_000 ? $"{ms / 3_600_000} h" : ms >= 60_000 ? $"{ms / 60_000} min" : $"{ms / 1000} s";
}
