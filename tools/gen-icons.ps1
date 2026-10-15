# tools/gen-icons.ps1 — generate extension icons: rounded blue square + white CJK glyph.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\gen-icons.ps1
# Requires Windows .NET Framework (System.Drawing); outputs icons/icon{16,32,48,128}.png

Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 128)
$outDir = Join-Path $PSScriptRoot '..\icons'
$fontName = 'Microsoft YaHei'
$charYi = [char]0x8BD1   # U+8BD1 = 'yi' (translate); avoids non-ASCII literals in this file

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # rounded-rect background (#2563eb)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $radius = [Math]::Max(2, [int]($size * 0.22))
    $d = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
    $g.FillPath($brush, $path)

    # white centered glyph
    $font = New-Object System.Drawing.Font($fontName, [float]($size * 0.62), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($charYi, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $format)

    $out = Join-Path $outDir ("icon$size.png")
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose(); $bmp.Dispose(); $path.Dispose(); $brush.Dispose(); $font.Dispose(); $format.Dispose()
    Write-Host "generated $out"
}
Write-Host 'done.'
