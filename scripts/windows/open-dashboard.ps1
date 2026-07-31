# Mirror of open-dashboard.sh: rebuild the dashboard, ensure the state server
# is listening on 127.0.0.1:7777, open the browser. Idempotent — a second
# call reuses the already-running server.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

node dashboard.mjs   # regenerate applications/index.html (no --open)

function Test-Port7777 {
  try { $c = New-Object System.Net.Sockets.TcpClient("127.0.0.1", 7777); $c.Close(); return $true }
  catch { return $false }
}

New-Item -ItemType Directory -Force -Path (Join-Path $repo "logs") | Out-Null
if (-not (Test-Port7777)) {
  # cmd /c keeps the log-append redirect (Start-Process cannot append).
  Start-Process -FilePath cmd -ArgumentList "/c node state-server.mjs >> logs\state-server.log 2>&1" -WorkingDirectory $repo -WindowStyle Hidden
  foreach ($i in 1..10) {
    if (Test-Port7777) { break }
    Start-Sleep -Milliseconds 200
  }
}

Start-Process "http://127.0.0.1:7777/"
