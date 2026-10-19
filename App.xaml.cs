using System.Runtime.InteropServices;
using System.Windows;

namespace Watcher;

public partial class App : Application
{
    internal const string InstanceKey = "Watcher-single-instance";
    private Mutex? _instance;
    private EventWaitHandle? _reveal;

    protected override void OnStartup(StartupEventArgs e)
    {
        // One Watcher per device, whatever its data folder or Windows session, since each one watches every container on the machine.
        // A second launch brings the open window forward and exits.
        bool first;
        try
        {
            _instance = new Mutex(true, $@"Global\{InstanceKey}", out first);
            _reveal = new EventWaitHandle(false, EventResetMode.AutoReset, $@"Global\{InstanceKey}-reveal");
        }
        catch (UnauthorizedAccessException)
        {
            // Another Windows user owns the lock, and their window can't be brought forward from here.
            MessageBox.Show("Watcher is already running for another user on this PC.", "Watcher", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(0);
            return;
        }
        if (!first)
        {
            AllowSetForegroundWindow(-1);
            _reveal.Set();
            Shutdown(0);
            return;
        }
        ThreadPool.RegisterWaitForSingleObject(_reveal,
            (_, _) => Dispatcher.BeginInvoke(() => (MainWindow as MainWindow)?.ShowWindow()), null, Timeout.Infinite, executeOnlyOnce: false);

        try { _ = Preferences.Startup; }
        catch (InvalidOperationException error)
        {
            MessageBox.Show(error.Message, "Watcher preferences", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }
        base.OnStartup(e);
        // Created here rather than by StartupUri, which would still build a window after Shutdown above.
        new MainWindow().Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instance?.Dispose();
        _reveal?.Dispose();
        base.OnExit(e);
    }

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);
}
