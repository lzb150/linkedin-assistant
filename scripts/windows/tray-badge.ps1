# Tray-icon unread badge — the Windows mirror of Jobs.app ("Вакансії").
# Polls notify-state.json (LinkedIn) + djinni-notify-state.json (Djinni)
# every 3 s, draws the summed unread count into the tray icon, opens the
# dashboard on left-click. Exit via the tray context menu.
# Start manually or at logon via register-tasks.ps1.
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts\windows -> repo root
$stateFiles = @(
  (Join-Path $repo "notify-state.json"),
  (Join-Path $repo "djinni-notify-state.json")
)
$dashboardUrl = "http://127.0.0.1:7777/"

function Get-UnreadCount {
  $sum = 0
  foreach ($f in $stateFiles) {
    try {
      $state = Get-Content -Raw -Path $f -ErrorAction Stop | ConvertFrom-Json
      if ($state.count -gt 0) { $sum += [int]$state.count }
    } catch {}   # missing/corrupt state file counts as 0, keep polling
  }
  return $sum
}

function New-BadgeIcon([int]$count) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  if ($count -gt 0) {
    $g.FillEllipse([System.Drawing.Brushes]::Crimson, 0, 0, 15, 15)
    $text = if ($count -gt 9) { "9+" } else { "$count" }
    $size = if ($count -gt 9) { 6 } else { 8 }
    $font = New-Object System.Drawing.Font("Segoe UI", $size, [System.Drawing.FontStyle]::Bold)
    $sz = $g.MeasureString($text, $font)
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, [float]((16 - $sz.Width) / 2), [float]((16 - $sz.Height) / 2))
  } else {
    # zero unread: plain briefcase-ish glyph
    $g.FillRectangle([System.Drawing.Brushes]::DimGray, 2, 6, 12, 8)
    $g.FillRectangle([System.Drawing.Brushes]::DimGray, 5, 3, 6, 3)
  }
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Visible = $true
$icon.Icon = New-BadgeIcon (Get-UnreadCount)
$icon.Text = "Jobs - unread threads"
$icon.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $dashboardUrl } })

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open dashboard", $null, { Start-Process $dashboardUrl })
[void]$menu.Items.Add("Exit", $null, { $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip = $menu

$script:last = -1
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  $n = Get-UnreadCount
  if ($n -ne $script:last) {
    $script:last = $n
    $old = $icon.Icon
    $icon.Icon = New-BadgeIcon $n
    if ($old) { $old.Dispose() }
    $icon.Text = "Jobs - $n unread thread(s)"
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
