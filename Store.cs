using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Watcher;

/// <summary>
/// SQLite history: raw samples (72 h), per-minute rollups and activity events (kept forever), the minutes the
/// monitor was watching, and the last observed state of every container. Writes run on the poll loop; page
/// queries open their own connection.
/// </summary>
public sealed partial class Store : IDisposable
{
    public const int RetentionHours = 72;
    private const long Hour = 3_600_000;
    private const long Minute = 60_000;

    public static readonly string Folder = Preferences.SessionFolder(Wslc.Session);

    public static string DefaultPath => System.IO.Path.Combine(Folder, "watcher.db");

    private const string Schema = """
        CREATE TABLE containers (name TEXT PRIMARY KEY, title TEXT, path TEXT, group_name TEXT, image TEXT,
          port TEXT, state TEXT, orphan INTEGER, first_seen INTEGER, last_seen INTEGER);
        CREATE TABLE samples (container TEXT, at INTEGER, cpu REAL, mem REAL, mem_limit REAL, mem_pct REAL,
          net_in REAL, net_out REAL, disk_read REAL, disk_write REAL, pids INTEGER,
          PRIMARY KEY (container, at)) WITHOUT ROWID;
        CREATE INDEX samples_at ON samples(at);
        CREATE TABLE minutes (container TEXT, minute INTEGER, n INTEGER, cpu_sum REAL, cpu_max REAL,
          mem_sum REAL, mem_max REAL, mem_limit REAL, net_in REAL, net_out REAL, disk_read REAL, disk_write REAL,
          PRIMARY KEY (container, minute)) WITHOUT ROWID;
        CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER, kind TEXT, container TEXT, summary TEXT, detail TEXT);
        CREATE INDEX events_at ON events(at);
        CREATE INDEX events_container ON events(container, at);
        CREATE TABLE watched (minute INTEGER PRIMARY KEY);
        PRAGMA user_version = 3;
        """;

    /// <summary>A removed container keeps its row so old samples and events still have a title.</summary>
    public const string Removed = "removed";

    private readonly string _connectionString;
    private readonly SqliteConnection _connection;
    private readonly Dictionary<string, Metrics> _counters = [];
    private long _prunedAt;
    private long _lastAt;
    private int _writes;

    public string Path { get; }
    public double WriteMsLast { get; private set; }
    public double WriteMsAvg { get; private set; }
    public double IntervalMs { get; private set; }

    public Store(string path) : this(path, Environment.ProcessorCount)
    {
    }

    /// <param name="processors">This machine's logical processor count, which a version 2 database's CPU is a share of.</param>
    public Store(string path, int processors)
    {
        Path = path;
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = path }.ToString();
        _connection = new SqliteConnection(_connectionString);
        _connection.Open();
        // Writes run on the UI thread: an fsync per commit (FULL) cost about 29 ms a snapshot, NORMAL about 1 ms.
        // In WAL mode NORMAL can only lose the last commits on power loss, never corrupt the file.
        Execute(_connection, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
        var version = Scalar(_connection, "PRAGMA user_version");
        var upgrade = version switch
        {
            0 => Schema,
            // Version 1 stored CPU per core in percent (400 is four cores).
            1 => CpuToCores("/ 100"),
            // Version 2 stored CPU as a percentage of this machine's logical processors.
            2 => CpuToCores($"* {processors} / 100"),
            _ => null,
        };
        if (upgrade is not null)
        {
            using var transaction = _connection.BeginTransaction();
            Execute(_connection, upgrade);
            transaction.Commit();
        }
    }

    /// <summary>Version 3 stores CPU as cores busy; <paramref name="scale"/> takes an older value there.</summary>
    private static string CpuToCores(string scale) => $"""
        UPDATE samples SET cpu = cpu {scale};
        UPDATE minutes SET cpu_sum = cpu_sum {scale}, cpu_max = cpu_max {scale};
        PRAGMA user_version = 3;
        """;

    public void Dispose()
    {
        _connection.Dispose();
        SqliteConnection.ClearPool(new SqliteConnection(_connectionString));
    }

    /// <summary>Last known state of every container still listed when the monitor last ran; null on a brand-new database.</summary>
    public Dictionary<string, ContainerInfo>? LoadContainers()
    {
        if (Scalar(_connection, "SELECT EXISTS (SELECT 1 FROM events)") == 0)
        {
            return null;
        }
        using var command = Command(_connection,
            "SELECT name, title, path, group_name, image, state, orphan, port FROM containers WHERE state <> $removed",
            ("$removed", Removed));
        using var reader = command.ExecuteReader();
        var containers = new Dictionary<string, ContainerInfo>();
        while (reader.Read())
        {
            containers[reader.GetString(0)] = new ContainerInfo(
                Name: reader.GetString(0), Title: reader.GetString(1), Path: reader.IsDBNull(2) ? null : reader.GetString(2),
                Group: reader.IsDBNull(3) ? null : reader.GetString(3), Branch: null, Image: reader.GetString(4),
                State: reader.GetString(5), Orphan: reader.GetBoolean(6), Port: reader.GetString(7), Uptime: "");
        }

        return containers;
    }

    /// <summary>The newest CPU and memory % samples of each running container, oldest first, for the sparklines.</summary>
    public Dictionary<string, (double[] Cpu, double[] Memory)> LoadHistory(long since, int count)
    {
        using var command = Command(_connection, """
            SELECT container, cpu, mem_pct FROM (
              SELECT s.container, s.at, s.cpu, s.mem_pct, ROW_NUMBER() OVER (PARTITION BY s.container ORDER BY s.at DESC) AS age
              FROM samples s JOIN containers c ON c.name = s.container AND c.state = 'running'
              WHERE s.at >= $since)
            WHERE age <= $count ORDER BY container, at
            """, ("$since", since), ("$count", count));
        using var reader = command.ExecuteReader();
        var rows = new List<(string Container, double Cpu, double Memory)>();
        while (reader.Read())
        {
            rows.Add((reader.GetString(0), reader.GetDouble(1), reader.GetDouble(2)));
        }

        return rows.GroupBy(r => r.Container).ToDictionary(
            g => g.Key, g => (g.Select(r => r.Cpu).ToArray(), g.Select(r => r.Memory).ToArray()));
    }

    /// <summary>One transaction per snapshot: samples, minute rollups, container rows and events.</summary>
    public IReadOnlyList<StoredEvent> Write(Snapshot snapshot, IReadOnlyList<ActivityEvent> events)
    {
        var watch = Stopwatch.StartNew();
        var at = snapshot.At;
        using var transaction = _connection.BeginTransaction();
        Execute(_connection, "INSERT OR IGNORE INTO watched (minute) VALUES ($minute)", ("$minute", at / Minute * Minute));
        foreach (var view in snapshot.Containers)
        {
            UpsertContainer(view.Info, at);
            if (view.Metrics is { } metrics)
            {
                InsertSample(view.Info.Name, at, metrics);
                RollUp(view.Info.Name, at, metrics);
            }
            else
            {
                _counters.Remove(view.Info.Name);
            }
        }
        Execute(_connection,
            "UPDATE containers SET state = $removed WHERE state <> $removed AND name NOT IN (SELECT value FROM json_each($names))",
            ("$removed", Removed), ("$names", JsonSerializer.Serialize(snapshot.Containers.Select(c => c.Info.Name))));
        foreach (var gone in _counters.Keys.Except(snapshot.Containers.Select(c => c.Info.Name)).ToList())
        {
            _counters.Remove(gone);
        }
        var ids = events.Select(Insert).ToList();
        if (at - _prunedAt >= Hour)
        {
            Prune(at);
        }
        transaction.Commit();

        Measure(watch.Elapsed.TotalMilliseconds, at);

        return ids.Select(ReadEvent).ToList();
    }

    /// <summary>An event outside a snapshot: a user action, the monitor stopping, wslc going offline.</summary>
    public StoredEvent Record(ActivityEvent activity) => ReadEvent(Insert(activity));

    private void Prune(long now)
    {
        Execute(_connection, "DELETE FROM samples WHERE at < $cutoff", ("$cutoff", now - RetentionHours * Hour));
        _prunedAt = now;
    }

    private void Measure(double milliseconds, long at)
    {
        WriteMsLast = milliseconds;
        WriteMsAvg += (milliseconds - WriteMsAvg) / ++_writes;
        if (_lastAt > 0)
        {
            IntervalMs = IntervalMs == 0 ? at - _lastAt : IntervalMs * 0.8 + (at - _lastAt) * 0.2;
        }
        _lastAt = at;
    }

    private void UpsertContainer(ContainerInfo info, long at) => Execute(_connection, """
        INSERT INTO containers (name, title, path, group_name, image, port, state, orphan, first_seen, last_seen)
        VALUES ($name, $title, $path, $group, $image, $port, $state, $orphan, $at, $at)
        ON CONFLICT (name) DO UPDATE SET title = excluded.title, path = excluded.path, group_name = excluded.group_name,
          image = excluded.image, port = excluded.port, state = excluded.state, orphan = excluded.orphan, last_seen = excluded.last_seen
        """,
        ("$name", info.Name), ("$title", info.Title), ("$path", info.Path), ("$group", info.Group), ("$image", info.Image),
        ("$port", info.Port), ("$state", info.State), ("$orphan", info.Orphan), ("$at", at));

    private void InsertSample(string name, long at, Metrics m) => Execute(_connection, """
        INSERT OR REPLACE INTO samples (container, at, cpu, mem, mem_limit, mem_pct, net_in, net_out, disk_read, disk_write, pids)
        VALUES ($name, $at, $cpu, $mem, $limit, $pct, $netIn, $netOut, $diskRead, $diskWrite, $pids)
        """,
        ("$name", name), ("$at", at), ("$cpu", m.Cpu), ("$mem", m.MemoryBytes), ("$limit", m.MemoryLimitBytes),
        ("$pct", m.MemoryPercent), ("$netIn", m.NetIn), ("$netOut", m.NetOut), ("$diskRead", m.DiskRead),
        ("$diskWrite", m.DiskWrite), ("$pids", m.Pids));

    /// <summary>Net and disk become summed deltas; a counter that went down means the container restarted.</summary>
    private void RollUp(string name, long at, Metrics m)
    {
        var previous = _counters.GetValueOrDefault(name) ?? m;
        _counters[name] = m;
        Execute(_connection, """
            INSERT INTO minutes (container, minute, n, cpu_sum, cpu_max, mem_sum, mem_max, mem_limit, net_in, net_out, disk_read, disk_write)
            VALUES ($name, $minute, 1, $cpu, $cpu, $mem, $mem, $limit, $netIn, $netOut, $diskRead, $diskWrite)
            ON CONFLICT (container, minute) DO UPDATE SET n = n + 1,
              cpu_sum = cpu_sum + excluded.cpu_sum, cpu_max = max(cpu_max, excluded.cpu_max),
              mem_sum = mem_sum + excluded.mem_sum, mem_max = max(mem_max, excluded.mem_max), mem_limit = excluded.mem_limit,
              net_in = net_in + excluded.net_in, net_out = net_out + excluded.net_out,
              disk_read = disk_read + excluded.disk_read, disk_write = disk_write + excluded.disk_write
            """,
            ("$name", name), ("$minute", at / Minute * Minute), ("$cpu", m.Cpu), ("$mem", m.MemoryBytes), ("$limit", m.MemoryLimitBytes),
            ("$netIn", Grew(previous.NetIn, m.NetIn)), ("$netOut", Grew(previous.NetOut, m.NetOut)),
            ("$diskRead", Grew(previous.DiskRead, m.DiskRead)), ("$diskWrite", Grew(previous.DiskWrite, m.DiskWrite)));
    }

    private static double Grew(double previous, double current) => current >= previous ? current - previous : 0;

    private long Insert(ActivityEvent activity) => Scalar(_connection,
        "INSERT INTO events (at, kind, container, summary, detail) VALUES ($at, $kind, $container, $summary, $detail) RETURNING id",
        ("$at", activity.At), ("$kind", activity.Kind), ("$container", activity.Container), ("$summary", activity.Summary),
        ("$detail", activity.Detail?.ToJsonString()));

    private StoredEvent ReadEvent(long id) =>
        ReadEvents(_connection, "WHERE e.id = $id", [("$id", id)]).Single();

    private const string EventColumns = """
        SELECT e.id, e.at, e.kind, e.container, c.title, e.summary, e.detail
        FROM events e LEFT JOIN containers c ON c.name = e.container
        """;

    private static List<StoredEvent> ReadEvents(SqliteConnection db, string clause, IEnumerable<(string, object?)> parameters)
    {
        using var command = Command(db, $"{EventColumns} {clause}", [.. parameters]);
        using var reader = command.ExecuteReader();
        var events = new List<StoredEvent>();
        while (reader.Read())
        {
            events.Add(new StoredEvent(
                Id: reader.GetInt64(0), At: reader.GetInt64(1), Kind: reader.GetString(2),
                Container: reader.IsDBNull(3) ? null : reader.GetString(3), Title: reader.IsDBNull(4) ? null : reader.GetString(4),
                Summary: reader.GetString(5), Detail: reader.IsDBNull(6) ? null : JsonNode.Parse(reader.GetString(6))?.AsObject()));
        }

        return events;
    }

    private static SqliteCommand Command(SqliteConnection db, string sql, params (string Name, object? Value)[] parameters)
    {
        var command = db.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        return command;
    }

    private static long Scalar(SqliteConnection db, string sql, params (string Name, object? Value)[] parameters)
    {
        using var command = Command(db, sql, parameters);

        return command.ExecuteScalar() is { } value and not DBNull ? Convert.ToInt64(value) : 0;
    }

    private static void Execute(SqliteConnection db, string sql, params (string Name, object? Value)[] parameters)
    {
        using var command = Command(db, sql, parameters);
        command.ExecuteNonQuery();
    }
}
