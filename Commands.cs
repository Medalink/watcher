using System.Diagnostics;
using System.IO;
using System.Text;

namespace Watcher;

public sealed record CommandResult(int Code, string Output, string Error = "", bool Truncated = false)
{
    public string Combined => string.Join("\n", new[] { Output.TrimEnd(), Error.TrimEnd() }.Where(s => s.Length > 0));
    public string RequireSuccess()
    {
        if (Code != 0)
        {
            throw new InvalidOperationException(Combined.Length == 0 ? $"wslc exited with code {Code}." : Combined);
        }
        return Output;
    }
}

public interface ICommandRunner
{
    Task<CommandResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default, TimeSpan? timeout = null);
}

public sealed class CommandRunner(string executable, string session = "") : ICommandRunner
{
    public const int OutputLimit = 2 * 1024 * 1024;

    public ProcessStartInfo StartInfo(IReadOnlyList<string> arguments)
    {
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        if (session.Length > 0)
        {
            info.ArgumentList.Add("--session");
            info.ArgumentList.Add(session);
        }
        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }
        return info;
    }

    public async Task<CommandResult> RunAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken = default, TimeSpan? timeout = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout ?? TimeSpan.FromSeconds(30));
        using var process = new Process { StartInfo = StartInfo(arguments) };
        process.Start();
        using var stop = deadline.Token.Register(() =>
        {
            try { process.Kill(entireProcessTree: true); }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        });
        var stdout = ReadAsync(process.StandardOutput);
        var stderr = ReadAsync(process.StandardError);
        try
        {
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);
            deadline.Token.ThrowIfCancellationRequested();
            var streams = await Task.WhenAll(stdout, stderr).WaitAsync(deadline.Token).ConfigureAwait(false);
            return new CommandResult(process.ExitCode, streams[0].Text, streams[1].Text, streams.Any(stream => stream.Truncated));
        }
        catch (OperationCanceledException cancelled)
        {
            var cleanup = "";
            try
            {
                await Task.WhenAll(process.WaitForExitAsync(CancellationToken.None), stdout, stderr)
                    .WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
            catch (TimeoutException) { cleanup = " Process or output cleanup did not finish; a runtime action may still be active."; }
            if (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException("Operation cancelled." + cleanup, cancelled, cancellationToken);
            }
            throw new TimeoutException($"wslc did not finish within {(timeout ?? TimeSpan.FromSeconds(30)).TotalSeconds:0} seconds." + cleanup);
        }
    }

    private static async Task<(string Text, bool Truncated)> ReadAsync(StreamReader reader)
    {
        var text = new StringBuilder();
        var buffer = new char[4096];
        var truncated = false;
        int count;
        while ((count = await reader.ReadAsync(buffer).ConfigureAwait(false)) > 0)
        {
            var keep = Math.Min(count, OutputLimit - text.Length);
            if (keep > 0) text.Append(buffer, 0, keep);
            truncated |= keep < count;
        }
        return (text.ToString(), truncated);
    }
}
