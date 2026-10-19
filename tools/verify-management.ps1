param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$proofRoot = Join-Path ([IO.Path]::GetTempPath()) ('watcher-proof-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $proofRoot | Out-Null
$token = [Guid]::NewGuid().ToString('N')
$containerName = 'watcher-proof-' + $token.Substring(0, 12)
$volumeName = $containerName + '-data'
$wslcPath = Join-Path $env:ProgramFiles 'WSL\wslc.exe'
$containerId = $null
$createdVolume = $false
$desktopHandle = [IntPtr]::Zero
$appProcess = $null
$proofEnvironment = @{}
foreach ($key in @('WATCHER_DATA_FOLDER','WATCHER_VERIFY_OUTPUT','WATCHER_VERIFY_CONTAINER','WATCHER_VERIFY_PORT','WATCHER_VERIFY_VOLUME','WATCHER_VERIFY_TOKEN')) {
    $proofEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

function Invoke-ProofWslc([string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($wslcPath)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(45000)) { $process.Kill($true); throw 'Owned proof command timed out.' }
    $output = $stdout.GetAwaiter().GetResult()
    $errorText = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw ('Proof wslc command failed: ' + $errorText + $output) }
    return $output.Trim()
}

try {
    $running = $null
    if ([Threading.Mutex]::TryOpenExisting('Global\Watcher-single-instance', [ref]$running)) {
        $running.Dispose()
        throw 'Close Watcher first. Only one Watcher runs per device, and the proof starts its own.'
    }
    if (!$SkipBuild) {
        dotnet build (Join-Path $projectRoot 'Watcher.csproj') -c Release --no-restore --verbosity quiet
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $image = @((Invoke-ProofWslc -Arguments @('image','list','--format','json')) -split "`n" | ForEach-Object { $_ | ConvertFrom-Json }) |
        Where-Object { $_.Repository -eq 'alpine' -and $_.Tag -eq '3.20' } | Select-Object -First 1
    if ($null -eq $image) { throw 'A cached alpine:3.20 image is required. The proof does not pull images.' }
    Invoke-ProofWslc -Arguments @('volume','create','--label',('watcher.proof=' + $token),$volumeName) | Out-Null
    $createdVolume = $true
    $containerId = Invoke-ProofWslc -Arguments @('run','--detach','--name',$containerName,'--label',('watcher.proof=' + $token),
        '--label','watcher.group=Watcher verification','--memory','64M','--cpus','0.25',
        '--publish',('127.0.0.1:' + $port + ':8080'),'--volume',($volumeName + ':/data'),
        '--health-cmd','wget -q -O - http://127.0.0.1:8080/','--health-interval','1s','--health-timeout','1s',
        '--entrypoint','/bin/sh',$image.ID,'-c',
        'printf watcher-backup > /data/marker.txt; echo watcher-proof-started; trap "exit 0" TERM INT; while true; do printf "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nwatcher-proof" | nc -l -p 8080 -w 2 >/dev/null; done')
    @{Container=$containerName;ContainerId=$containerId;Volume=$volumeName;Token=$token;Port=$port;Output=$proofRoot} |
        ConvertTo-Json | Set-Content (Join-Path $proofRoot 'manifest.json')
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WatcherProofDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct StartupInfo {
        public int cb; public string reserved; public string desktop; public string title;
        public int x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
        public short showWindow,reserved2; public IntPtr reservedPointer,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    public static extern bool CreateProcess(string application,string command,IntPtr processSecurity,IntPtr threadSecurity,bool inheritHandles,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
    $desktopName = 'WatcherProof' + $token
    $desktopHandle = [WatcherProofDesktop]::CreateDesktop($desktopName,[IntPtr]::Zero,[IntPtr]::Zero,0,0x1ff,[IntPtr]::Zero)
    if ($desktopHandle -eq [IntPtr]::Zero) { throw ('CreateDesktop failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $env:WATCHER_DATA_FOLDER = Join-Path $proofRoot 'data'
    $env:WATCHER_VERIFY_OUTPUT = $proofRoot
    $env:WATCHER_VERIFY_CONTAINER = $containerName
    $env:WATCHER_VERIFY_PORT = [string]$port
    $env:WATCHER_VERIFY_VOLUME = $volumeName
    $env:WATCHER_VERIFY_TOKEN = $token
    $startup = [WatcherProofDesktop+StartupInfo]::new()
    $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
    $startup.desktop = 'winsta0\' + $desktopName
    $nativeProcess = [WatcherProofDesktop+ProcessInfo]::new()
    $executable = Join-Path $projectRoot 'bin\Release\net10.0-windows\Watcher.exe'
    if (![WatcherProofDesktop]::CreateProcess($executable,('"' + $executable + '"'),[IntPtr]::Zero,[IntPtr]::Zero,$false,0,[IntPtr]::Zero,$projectRoot,[ref]$startup,[ref]$nativeProcess)) {
        throw ('CreateProcess failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    [WatcherProofDesktop]::CloseHandle($nativeProcess.thread) | Out-Null
    [WatcherProofDesktop]::CloseHandle($nativeProcess.process) | Out-Null
    $appProcess = [Diagnostics.Process]::GetProcessById($nativeProcess.processId)
    if (!$appProcess.WaitForExit(120000)) { $appProcess.Kill($true); throw 'Owned verification instance timed out.' }
    $resultPath = Join-Path $proofRoot 'result.json'
    if (!(Test-Path -LiteralPath $resultPath)) { throw ('Verification instance exited without a result; exit code ' + $appProcess.ExitCode) }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Write-Output ('Proof artifacts: ' + $proofRoot)
    if (!$result.ok) { throw ('WebView verification failed: ' + $result.error) }
    Write-Output 'Native WebView verification passed.'
}
finally {
    foreach ($key in $proofEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $proofEnvironment[$key], 'Process') }
    if ($null -ne $appProcess -and !$appProcess.HasExited) { $appProcess.Kill($true) }
    if ($desktopHandle -ne [IntPtr]::Zero) { [WatcherProofDesktop]::CloseDesktop($desktopHandle) | Out-Null }
    if ($null -ne $containerId) {
        try {
            $owned = Invoke-ProofWslc -Arguments @('container','inspect','--format','json',$containerName) | ConvertFrom-Json
            if ($owned.Labels.'watcher.proof' -eq $token -and $owned.Id.StartsWith($containerId.Trim())) {
                Invoke-ProofWslc -Arguments @('remove','--force',$containerName) | Out-Null
                Write-Output ('Removed owned container ' + $containerName)
            } else { Write-Warning 'Container ownership verification failed; no deletion attempted.' }
        } catch { Write-Warning ('Owned container cleanup: ' + $_.Exception.Message) }
    }
    if ($createdVolume) {
        try {
            $ownedVolume = Invoke-ProofWslc -Arguments @('volume','inspect',$volumeName) | ConvertFrom-Json
            if ($ownedVolume.Labels.'watcher.proof' -eq $token) {
                Invoke-ProofWslc -Arguments @('volume','remove',$volumeName) | Out-Null
                Write-Output ('Removed owned volume ' + $volumeName)
            } else { Write-Warning 'Volume ownership verification failed; no deletion attempted.' }
        } catch { Write-Warning ('Owned volume cleanup: ' + $_.Exception.Message) }
    }
}
