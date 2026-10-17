using System.Globalization;
using System.Text.RegularExpressions;

namespace Watcher;

public static class ControlCommands
{
    public static string[] Lifecycle(string name, string operation, int? timeout = null)
    {
        if (!IsContainerName(name))
            throw new ArgumentException("Invalid container name.");
        if (operation is not ("start" or "stop" or "restart" or "remove")) throw new ArgumentException("Unsupported lifecycle action.");
        if (timeout is < 1 or > 120) throw new ArgumentException("Stop timeout must be between 1 and 120 seconds.");
        if (operation == "remove") return ["remove", "--force", name];
        if (operation == "start" || timeout is null) return [operation, name];
        return [operation, operation == "restart" ? "--timeout" : "--time", timeout.Value.ToString(CultureInfo.InvariantCulture), name];
    }

    public static bool IsContainerName(string name) => !string.IsNullOrWhiteSpace(name)
        && Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$");

    public static string[] Terminal(string name, string session, string user, string workdir, string shell)
    {
        if (!IsContainerName(name)) throw new ArgumentException("Invalid container name.");
        if (new[] { session, user, workdir, shell }.Any(s => s.Any(c => char.IsControl(c) || c == ';')))
            throw new ArgumentException("Terminal options must not contain control characters or command separators.");
        if (!shell.StartsWith('/') || shell.Any(char.IsWhiteSpace)) throw new ArgumentException("Use an absolute executable path for the shell.");
        if (workdir.Length > 0 && !workdir.StartsWith('/')) throw new ArgumentException("Use an absolute Linux working directory.");
        var arguments = new List<string>();
        if (session.Length > 0) arguments.AddRange(["--session", session]);
        arguments.AddRange(["exec", "--interactive", "--tty"]);
        if (user.Length > 0) arguments.AddRange(["--user", user]);
        if (workdir.Length > 0) arguments.AddRange(["--workdir", workdir]);
        arguments.AddRange([name, shell]);
        return arguments.ToArray();
    }

    public static string[] TerminateSession(string active, string requested, bool confirmed)
    {
        if (!confirmed) throw new ArgumentException("Confirm the affected session before terminating it.");
        if (requested != active && !(active.Length == 0 && requested == "default"))
            throw new ArgumentException("Watcher can terminate only its active session.");
        return ["system", "session", "terminate"];
    }
}
