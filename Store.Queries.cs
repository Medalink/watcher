using System.IO;
using Microsoft.Data.Sqlite;

namespace Watcher;

/// <summary>A Stats page range: how far back it looks, how wide each bucket is, and whether it reads raw samples.</summary>
public sealed record StatsRange(string Key, long SpanMs, long BucketMs, bool Raw)
{
    private static readonly Dictionary<string, StatsRange> All = new StatsRange[]
    {
        new("1h", 3_600_000, 15_000, Raw: true),
        new("24h", 86_400_000, 300_000, Raw: false),
        new("7d", 7 * 86_400_000L, 1_800_000, Raw: false),
        new("30d", 30 * 86_400_000L, 7_200_000, Raw: false),
    }.ToDictionary(r => r.Key);

    public static StatsRange Parse(string? key) =>
        key is not null && All.TryGetValue(key, out var range) ? range : throw new ArgumentException($"Unknown range '{key}'.");
}

public sealed record SeriesPoint(long At, double Cpu, double Memory, int Running);

public sealed record Peaks(double Cpu, long? CpuAt, double Memory, long? MemoryAt);

/// <summary><paramref name="UptimePct"/> is the share of the minutes the monitor was watching that had a sample.</summary>
public sealed record ContainerStats(
    string Name, string Title, long Samples,
    double CpuAvg, double CpuP95, double CpuMax, double MemAvg, double MemMax, double MemLimit,
    double NetIn, double NetOut, double DiskRead, double DiskWrite, double UptimePct, int Restarts);

public sealed record DbInfo(
    string Path, long SizeBytes, long Samples, long Minutes, long Events, long? OldestAt, int RetentionHours,
    double WriteMsLast, double WriteMsAvg, double IntervalMs);

/// <summary>CPU values are cores busy; <paramref name="Capacity"/> is what the page and the report divide them by.</summary>
public sealed record StatsResult(
    long From, long To, long BucketMs, IReadOnlyList<SeriesPoint> Series, Peaks Peaks,
    IReadOnlyList<ContainerStats> Containers, IReadOnlyDictionary<string, long> Events, DbInfo Db, Capacities Capacity);

/// <summary>Activity page filters; null kinds means every kind, an empty list means none.</summary>
public sealed record ActivityQuery(long? Before = null, string? Container = null, IReadOnlyList<string>? Kinds = null, string? Search = null, int Limit = 200);

public sealed record ActivityPage(IReadOnlyList<StoredEvent> Events, bool More);

public sealed record KnownContainer(string Name, string Title, string State);

/// <summary>A page of removed containers; a <paramref name="Limit"/> of 0 only counts them.</summary>
public sealed record RemovedQuery(int Offset = 0, int Limit = 10);

/// <summary>How a container was removed, as web/containers.js reads it.</summary>
public static class Removal
{
    public const string Reap = "reap";
    public const string Limit = "limit";
    public const string Watcher = "watcher";
    public const string Outside = "outside";
}

/// <summary>
/// A removed container's last known row. <paramref name="RemovedBy"/> is a <see cref="Removal"/> value;
/// memory is bytes and CPU cores busy over its whole life, null without samples.
/// </summary>
public sealed record RemovedContainer(
    string Name, string Title, string? Path, string? Group, string Image, string Port,
    long FirstSeen, long RemovedAt, string RemovedBy, bool WasOrphan, bool HasFolder, double? PeakMemory, double? AvgCpuCores);

public sealed record RemovedPage(IReadOnlyList<RemovedContainer> Items, long Total);

public sealed partial class Store
{
    /// <summary>One container's samples in one bucket, from raw samples (1h) or minute rollups.</summary>
    private sealed record Bucket(string Container, long At, long N, double CpuSum, double CpuMax, double MemSum, double MemMax, double MemLimit)
    {
        public double Cpu => CpuSum / N;
        public double Memory => MemSum / N;
    }

    private sealed record Totals(double NetIn, double NetOut, double DiskRead, double DiskWrite, long Minutes);

    public StatsResult Stats(string range, long now, Capacities capacity)
    {
        var r = StatsRange.Parse(range);
        var (from, to) = (now - r.SpanMs, now);
        using var db = Open();
        var buckets = Buckets(db, r, from, to);
        var series = buckets.GroupBy(b => b.At).OrderBy(g => g.Key)
            .Select(g => new SeriesPoint(g.Key, g.Sum(b => b.Cpu), g.Sum(b => b.Memory), g.Count())).ToList();
        var cpuPeak = series.MaxBy(p => p.Cpu);
        var memoryPeak = series.MaxBy(p => p.Memory);
        var peaks = new Peaks(cpuPeak?.Cpu ?? 0, cpuPeak?.At, memoryPeak?.Memory ?? 0, memoryPeak?.At);

        var names = Names(db);
        var totals = MinuteTotals(db, from, to);
        var restarts = Restarts(db, from, to);
        var watched = Scalar(db, "SELECT COUNT(*) FROM watched WHERE minute >= $from AND minute <= $to", ("$from", from), ("$to", to));
        var containers = buckets.GroupBy(b => b.Container).Select(g =>
        {
            var n = g.Sum(b => b.N);
            var title = names.GetValueOrDefault(g.Key, g.Key);
            var t = totals.GetValueOrDefault(g.Key) ?? new Totals(0, 0, 0, 0, 0);
            return new ContainerStats(
                g.Key, title, n,
                CpuAvg: g.Sum(b => b.CpuSum) / n, CpuP95: P95(g.Select(b => b.Cpu)), CpuMax: g.Max(b => b.CpuMax),
                MemAvg: g.Sum(b => b.MemSum) / n, MemMax: g.Max(b => b.MemMax), MemLimit: g.Max(b => b.MemLimit),
                t.NetIn, t.NetOut, t.DiskRead, t.DiskWrite,
                UptimePct: watched == 0 ? 0 : Math.Min(100, t.Minutes * 100d / watched), Restarts: restarts.GetValueOrDefault(g.Key));
        }).OrderByDescending(c => c.CpuAvg).ToList();

        return new StatsResult(from, to, r.BucketMs, series, peaks, containers, EventCounts(db, from, to), Info(db), capacity);
    }

    public ActivityPage Activity(ActivityQuery query)
    {
        var clauses = new List<string>();
        var parameters = new List<(string, object?)>();
        if (query.Before is { } before)
        {
            clauses.Add("e.id < $before");
            parameters.Add(("$before", before));
        }
        if (!string.IsNullOrEmpty(query.Container))
        {
            clauses.Add("e.container = $container");
            parameters.Add(("$container", query.Container));
        }
        if (query.Kinds is { } kinds)
        {
            clauses.Add($"e.kind IN ({string.Join(", ", kinds.Select((_, i) => $"$kind{i}").DefaultIfEmpty("NULL"))})");
            parameters.AddRange(kinds.Select((kind, i) => ($"$kind{i}", (object?)kind)));
        }
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            clauses.Add("instr(lower(e.summary || ' ' || coalesce(e.container, '') || ' ' || coalesce(c.title, '') || ' ' || coalesce(e.detail, '')), lower($search)) > 0");
            parameters.Add(("$search", query.Search.Trim()));
        }
        parameters.Add(("$limit", query.Limit + 1));
        var where = clauses.Count == 0 ? "" : $"WHERE {string.Join(" AND ", clauses)}";
        using var db = Open();
        var events = ReadEvents(db, $"{where} ORDER BY e.id DESC LIMIT $limit", parameters);

        return new ActivityPage(events.Take(query.Limit).ToList(), events.Count > query.Limit);
    }

    /// <summary>Every container the monitor has seen, removed ones included, for the Activity filter.</summary>
    public IReadOnlyList<KnownContainer> Containers()
    {
        using var db = Open();
        using var command = Command(db, "SELECT name, title, state FROM containers ORDER BY title COLLATE NOCASE");
        using var reader = command.ExecuteReader();
        var containers = new List<KnownContainer>();
        while (reader.Read())
        {
            containers.Add(new KnownContainer(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        }

        return containers;
    }

    /// <summary>A remove from Watcher counts when it succeeded within this long before the container disappeared.</summary>
    private const long RemovalLeadMs = 5 * Minute;

    /// <summary>A snapshot can see the container gone before wslc remove returns and its action is recorded.</summary>
    private const long RemovalLagMs = Minute;

    /// <summary>
    /// Removed containers, newest removed first. Removed at is the last disappeared event, else the last time it
    /// was seen; how it went is the newest successful remove action around then, else outside Watcher.
    /// </summary>
    public RemovedPage RemovedContainers(RemovedQuery query)
    {
        using var db = Open();
        var total = Scalar(db, "SELECT COUNT(*) FROM containers WHERE state = $removed", ("$removed", Removed));
        if (query.Limit == 0)
        {
            return new RemovedPage([], total);
        }
        using var command = Command(db, $"""
            WITH page AS (
              SELECT c.name, c.title, c.path, c.group_name, c.image, c.port, c.orphan, c.first_seen,
                coalesce((SELECT MAX(at) FROM events WHERE container = c.name AND kind = '{ActivityKind.Disappeared}'), c.last_seen) AS removed_at
              FROM containers c WHERE c.state = $removed
              ORDER BY removed_at DESC, c.name LIMIT $limit OFFSET $offset)
            SELECT name, title, path, group_name, image, port, orphan, first_seen, removed_at,
              coalesce((
                SELECT CASE json_extract(a.detail, '$.source') WHEN 'reap' THEN '{Removal.Reap}' WHEN 'limit' THEN '{Removal.Limit}' ELSE '{Removal.Watcher}' END
                FROM events a
                WHERE a.container = page.name AND a.kind = '{ActivityKind.Action}' AND json_extract(a.detail, '$.op') = 'remove'
                  AND json_extract(a.detail, '$.ok') = 1 AND a.at BETWEEN page.removed_at - $lead AND page.removed_at + $lag
                ORDER BY a.at DESC LIMIT 1), '{Removal.Outside}'),
              (SELECT MAX(mem_max) FROM minutes WHERE container = page.name),
              (SELECT SUM(cpu_sum) / SUM(n) FROM minutes WHERE container = page.name)
            FROM page ORDER BY removed_at DESC, name
            """,
            ("$removed", Removed), ("$limit", query.Limit), ("$offset", query.Offset), ("$lead", RemovalLeadMs), ("$lag", RemovalLagMs));
        using var reader = command.ExecuteReader();
        var items = new List<RemovedContainer>();
        while (reader.Read())
        {
            var path = reader.IsDBNull(2) ? null : reader.GetString(2);
            items.Add(new RemovedContainer(
                Name: reader.GetString(0), Title: reader.GetString(1), Path: path, Group: reader.IsDBNull(3) ? null : reader.GetString(3),
                Image: reader.GetString(4), Port: reader.GetString(5), FirstSeen: reader.GetInt64(7), RemovedAt: reader.GetInt64(8),
                RemovedBy: reader.GetString(9), WasOrphan: reader.GetBoolean(6), HasFolder: path is not null && Directory.Exists(path),
                PeakMemory: reader.IsDBNull(10) ? null : reader.GetDouble(10), AvgCpuCores: reader.IsDBNull(11) ? null : reader.GetDouble(11)));
        }

        return new RemovedPage(items, total);
    }

    /// <summary>Every event in a time range, oldest first, for the export.</summary>
    public IReadOnlyList<StoredEvent> Events(long from, long to)
    {
        using var db = Open();

        return ReadEvents(db, "WHERE e.at >= $from AND e.at <= $to ORDER BY e.at, e.id", [("$from", from), ("$to", to)]);
    }

    /// <summary>Readers get their own connection so a long query never waits on, or blocks, the poll loop's writes.</summary>
    private SqliteConnection Open()
    {
        var db = new SqliteConnection(_connectionString);
        db.Open();

        return db;
    }

    private static List<Bucket> Buckets(SqliteConnection db, StatsRange range, long from, long to)
    {
        var sql = range.Raw
            ? """
              SELECT container, at / $bucket * $bucket AS slot, COUNT(*), SUM(cpu), MAX(cpu), SUM(mem), MAX(mem), MAX(mem_limit)
              FROM samples WHERE at >= $from AND at <= $to GROUP BY container, slot
              """
            : """
              SELECT container, minute / $bucket * $bucket AS slot, SUM(n), SUM(cpu_sum), MAX(cpu_max), SUM(mem_sum), MAX(mem_max), MAX(mem_limit)
              FROM minutes WHERE minute >= $from AND minute <= $to GROUP BY container, slot
              """;
        using var command = Command(db, sql, ("$bucket", range.BucketMs), ("$from", from), ("$to", to));
        using var reader = command.ExecuteReader();
        var buckets = new List<Bucket>();
        while (reader.Read())
        {
            buckets.Add(new Bucket(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2), reader.GetDouble(3),
                reader.GetDouble(4), reader.GetDouble(5), reader.GetDouble(6), reader.GetDouble(7)));
        }

        return buckets;
    }

    /// <summary>Nearest-rank 95th percentile.</summary>
    private static double P95(IEnumerable<double> values)
    {
        var sorted = values.Order().ToList();

        return sorted.Count == 0 ? 0 : sorted[(int)Math.Ceiling(sorted.Count * 0.95) - 1];
    }

    private static Dictionary<string, string> Names(SqliteConnection db)
    {
        using var command = Command(db, "SELECT name, title FROM containers");
        using var reader = command.ExecuteReader();
        var names = new Dictionary<string, string>();
        while (reader.Read())
        {
            names[reader.GetString(0)] = reader.GetString(1);
        }

        return names;
    }

    private static Dictionary<string, Totals> MinuteTotals(SqliteConnection db, long from, long to)
    {
        using var command = Command(db, """
            SELECT container, SUM(net_in), SUM(net_out), SUM(disk_read), SUM(disk_write), COUNT(*)
            FROM minutes WHERE minute >= $from AND minute <= $to GROUP BY container
            """, ("$from", from), ("$to", to));
        using var reader = command.ExecuteReader();
        var totals = new Dictionary<string, Totals>();
        while (reader.Read())
        {
            totals[reader.GetString(0)] = new Totals(reader.GetDouble(1), reader.GetDouble(2), reader.GetDouble(3), reader.GetDouble(4), reader.GetInt64(5));
        }

        return totals;
    }

    private static Dictionary<string, int> Restarts(SqliteConnection db, long from, long to)
    {
        using var command = Command(db, """
            SELECT container, COUNT(*) FROM events
            WHERE kind = 'state' AND json_extract(detail, '$.to') = 'running' AND at >= $from AND at <= $to GROUP BY container
            """, ("$from", from), ("$to", to));
        using var reader = command.ExecuteReader();
        var restarts = new Dictionary<string, int>();
        while (reader.Read())
        {
            restarts[reader.GetString(0)] = reader.GetInt32(1);
        }

        return restarts;
    }

    private static Dictionary<string, long> EventCounts(SqliteConnection db, long from, long to)
    {
        using var command = Command(db, "SELECT kind, COUNT(*) FROM events WHERE at >= $from AND at <= $to GROUP BY kind", ("$from", from), ("$to", to));
        using var reader = command.ExecuteReader();
        var counts = new Dictionary<string, long>();
        while (reader.Read())
        {
            counts[reader.GetString(0)] = reader.GetInt64(1);
        }

        return counts;
    }

    private DbInfo Info(SqliteConnection db)
    {
        using var oldest = Command(db, "SELECT MIN(at) FROM (SELECT MIN(minute) AS at FROM minutes UNION ALL SELECT MIN(at) FROM events)");
        var size = new[] { Path, $"{Path}-wal" }.Select(file => new FileInfo(file)).Where(file => file.Exists).Sum(file => file.Length);

        return new DbInfo(
            Path, size,
            Scalar(db, "SELECT COUNT(*) FROM samples"), Scalar(db, "SELECT COUNT(*) FROM minutes"), Scalar(db, "SELECT COUNT(*) FROM events"),
            oldest.ExecuteScalar() is long at ? at : null, RetentionHours,
            Math.Round(WriteMsLast, 2), Math.Round(WriteMsAvg, 2), Math.Round(IntervalMs));
    }
}
