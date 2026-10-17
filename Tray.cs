using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Interop;
using Microsoft.Win32;

namespace Watcher;

public sealed class Tray : IDisposable
{
    private const int Callback = 0x8001;
    private readonly HwndSource _source;
    private readonly Action _show;
    private readonly Func<ContextMenu> _menu;
    private NotifyIconData _data;
    private readonly bool _ownsIcon;
    private readonly uint _taskbarCreated = RegisterWindowMessage("TaskbarCreated");

    public Tray(Window window, Action show, Func<ContextMenu> menu)
    {
        _show = show;
        _menu = menu;
        var handle = new WindowInteropHelper(window).EnsureHandle();
        _source = HwndSource.FromHwnd(handle)!;
        _source.AddHook(Message);
        var icons = new IntPtr[1];
        ExtractIconEx(Environment.ProcessPath!, 0, icons, null, 1);
        _ownsIcon = icons[0] != IntPtr.Zero;
        _data = new NotifyIconData
        {
            Size = (uint)Marshal.SizeOf<NotifyIconData>(), Window = handle, Id = 1, Flags = 7,
            CallbackMessage = Callback, Icon = _ownsIcon ? icons[0] : LoadIcon(IntPtr.Zero, new IntPtr(32512)), Tip = "Watcher · WSLc containers",
            Info = "", InfoTitle = "",
        };
        if (!ShellNotifyIcon(0, ref _data))
        {
            _source.RemoveHook(Message);
            if (_ownsIcon) DestroyIcon(_data.Icon);
            throw new InvalidOperationException("Windows could not add Watcher to the notification area.");
        }
    }

    public void Notify(string title, string message)
    {
        _data.Flags = 16;
        _data.InfoTitle = title.Length > 63 ? title[..63] : title;
        _data.Info = message.Length > 255 ? message[..255] : message;
        _data.InfoFlags = 1;
        ShellNotifyIcon(1, ref _data);
        _data.Flags = 7;
    }

    private IntPtr Message(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if ((uint)message == _taskbarCreated)
        {
            _data.Flags = 7;
            ShellNotifyIcon(0, ref _data);
        }
        if (message != Callback) return IntPtr.Zero;
        switch (lParam.ToInt32() & 0xffff)
        {
            case 0x0202:
            case 0x0405:
                _show();
                break;
            case 0x0205:
                SetForegroundWindow(window);
                var menu = _menu();
                menu.Placement = PlacementMode.MousePoint;
                menu.IsOpen = true;
                break;
        }
        handled = true;
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        _source.RemoveHook(Message);
        ShellNotifyIcon(2, ref _data);
        if (_ownsIcon && _data.Icon != IntPtr.Zero) DestroyIcon(_data.Icon);
    }

    public static void RegisterStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (enabled) key.SetValue("Watcher", $"\"{Environment.ProcessPath}\" --background");
        else key.DeleteValue("Watcher", throwOnMissingValue: false);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size;
        public IntPtr Window;
        public uint Id, Flags;
        public int CallbackMessage;
        public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Timeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags;
        public Guid Guid;
        public IntPtr BalloonIcon;
    }

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ShellNotifyIcon(uint message, ref NotifyIconData data);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[]? small, uint count);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", EntryPoint = "LoadIconW")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr icon);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
}
