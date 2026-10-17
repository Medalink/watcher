using System.Windows;

namespace Watcher;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        try { _ = Preferences.Startup; }
        catch (InvalidOperationException error)
        {
            MessageBox.Show(error.Message, "Watcher preferences", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }
        base.OnStartup(e);
    }
}
