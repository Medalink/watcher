# Draws app.ico: an eye on a square sky-to-violet tile, the same mark as the rail logo in web/index.html.
# Run with Windows PowerShell, which ships System.Drawing:  powershell -File tools/icon.ps1
param([string]$Out = (Join-Path $PSScriptRoot '..\app.ico'))

Add-Type -AssemblyName System.Drawing
$sizes = 16, 24, 32, 48, 64, 256
$sky = [System.Drawing.Color]::FromArgb(56, 189, 248)
$violet = [System.Drawing.Color]::FromArgb(139, 92, 246)

# The mark is designed on a 32-unit grid, as in the SVG.
function Point($x, $y) { New-Object System.Drawing.PointF ($x * $script:unit), ($y * $script:unit) }
function Disc($g, $brush, $cx, $cy, $r) { $g.FillEllipse($brush, ($cx - $r) * $script:unit, ($cy - $r) * $script:unit, 2 * $r * $script:unit, 2 * $r * $script:unit) }

$pngs = foreach ($n in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $n, $n
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $script:unit = $n / 32.0

    $tile = New-Object System.Drawing.Drawing2D.LinearGradientBrush (Point 0 0), (Point 32 32), $sky, $violet
    $g.FillRectangle($tile, 0, 0, $n, $n)

    # Two quadratic lids from (4,16) to (28,16) through (16,5) and (16,27), written as cubics.
    $eye = New-Object System.Drawing.Drawing2D.GraphicsPath
    $eye.AddBezier((Point 4 16), (Point 12 (16 - 22 / 3)), (Point 20 (16 - 22 / 3)), (Point 28 16))
    $eye.AddBezier((Point 28 16), (Point 20 (16 + 22 / 3)), (Point 12 (16 + 22 / 3)), (Point 4 16))
    $eye.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $eye)

    $ring = New-Object System.Drawing.Drawing2D.LinearGradientBrush (Point 11.4 11.4), (Point 20.6 20.6), $sky, $violet
    Disc $g $ring 16 16 4.6
    Disc $g (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 15, 15))) 16 16 2

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    , $ms.ToArray()
}

# ICO: a header, one 16-byte directory entry per size, then the PNG images.
$fs = [System.IO.File]::Create([System.IO.Path]::GetFullPath($Out))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $n = $sizes[$i]; $len = $pngs[$i].Length
    $bw.Write([byte]($n % 256)); $bw.Write([byte]($n % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
    $offset += $len
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()
"wrote $Out"
