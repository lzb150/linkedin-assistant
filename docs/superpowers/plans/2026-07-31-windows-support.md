# Windows Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows parity for the convenience shell — toast notifications, tray-icon unread badge, Task Scheduler templates, cross-platform dashboard opening — plus the repo's first CI running the suite on ubuntu/macos/windows.

**Architecture:** Platform dispatch inside the existing modules (`lib/notify.mjs` gains a per-platform command builder; a new 20-line `lib/open.mjs` replaces the raw `open` call). Everything Windows-specific is plain PowerShell (built-in .NET, no compile step) under `scripts/windows/`, following the repo's `*.example` convention for machine-specific files. The macOS path stays byte-identical.

**Tech Stack:** Node ESM, `node:test`, PowerShell 5.1+ (WinRT toasts, WinForms NotifyIcon), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-31-windows-support-design.md`

## Global Constraints

- No new npm dependencies; Windows pieces use PowerShell + built-in .NET only.
- The macOS behavior stays byte-identical: darwin keeps osascript banners, Jobs.app, `open`.
- Notification/open arguments are passed as argv, never shell-interpolated — titles carry scraped job-board text.
- All notification/open paths are best-effort and never throw (existing contract).
- Machine-specific Windows files ship as `.example`; the filled-in copies (`scripts/windows/run.ps1`, `run-jobs.ps1`, `register-tasks.ps1`) are gitignored.
- CI must not download Playwright browsers (`npm ci` only — tests never launch a browser).
- README.md English; README.uk.md Ukrainian mirror.

---

### Task 1: Platform dispatch — `lib/notify.mjs`, `lib/open.mjs`, `dashboard.mjs`

**Files:**
- Modify: `lib/notify.mjs` (header comment, imports, new `notifyCommand`, `notify` signature, `ensureJobsApp` guard)
- Create: `lib/open.mjs`
- Modify: `dashboard.mjs` (the `--open` call at the bottom + its import)
- Test: `test/notify.test.mjs`, `test/open.test.mjs` (new files)

**Interfaces:**
- Consumes: nothing from other tasks. `scripts/windows/toast.ps1` (Task 2) does not exist yet — `notifyCommand` only builds the path string, so nothing breaks.
- Produces: `notifyCommand(title, message, platform) -> [cmd, args]`; `notify(title, message, { platform = process.platform, exec = execFile } = {})` (existing two-arg call sites in check.mjs/jobs.mjs/djinni-check.mjs/followup.mjs stay valid unchanged); `openCommand(target, platform) -> [cmd, args]`; `openPath(target, { platform, exec } = {})`.

- [ ] **Step 1: Write the failing tests**

Create `test/notify.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyCommand } from "../lib/notify.mjs";

test("notifyCommand: darwin uses osascript with the AppleScript body", () => {
  const [cmd, args] = notifyCommand("Job assistant", "3 new", "darwin");
  assert.equal(cmd, "osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /display notification "3 new" with title "Job assistant"/);
});

test("notifyCommand: win32 calls the toast script with argv params", () => {
  const [cmd, args] = notifyCommand('Strong "match"', "Senior AQA @ Acme", "win32");
  assert.equal(cmd, "powershell");
  assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.match(args[4], /scripts[\\/]windows[\\/]toast\.ps1$/);
  // title/message are separate argv entries — never shell-interpolated
  assert.deepEqual(args.slice(5), ["-Title", 'Strong "match"', "-Message", "Senior AQA @ Acme"]);
});

test("notifyCommand: linux uses notify-send", () => {
  assert.deepEqual(notifyCommand("t", "m", "linux"), ["notify-send", ["t", "m"]]);
});

test("notify passes the built command to exec and never throws", () => {
  let seen;
  notify("t", "m", { platform: "win32", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(new Error("boom")); } });
  assert.equal(seen.cmd, "powershell");
  // synchronously-throwing exec is swallowed too
  notify("t", "m", { platform: "darwin", exec: () => { throw new Error("boom"); } });
});
```

Create `test/open.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPath, openCommand } from "../lib/open.mjs";

test("openCommand per platform", () => {
  assert.deepEqual(openCommand("http://x/", "darwin"), ["open", ["http://x/"]]);
  assert.deepEqual(openCommand("C:\\a b\\index.html", "win32"), ["cmd", ["/c", "start", "", "C:\\a b\\index.html"]]);
  assert.deepEqual(openCommand("/tmp/i.html", "linux"), ["xdg-open", ["/tmp/i.html"]]);
});

test("openPath passes through exec and never throws", () => {
  let seen;
  openPath("target", { platform: "win32", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(null); } });
  assert.equal(seen.cmd, "cmd");
  openPath("target", { platform: "darwin", exec: () => { throw new Error("boom"); } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/notify.test.mjs test/open.test.mjs`
Expected: FAIL — `notifyCommand` not exported / `../lib/open.mjs` not found.

- [ ] **Step 3: Implement**

Rewrite the top of `lib/notify.mjs` (header, imports, `notifyCommand`, `notify`) — `log` and the body of `ensureJobsApp` stay as they are, with one added guard line:

```js
// Shared cross-platform notification helpers (previously copy-pasted in
// check.mjs, djinni-check.mjs, jobs.mjs and followup.mjs). macOS banners go
// through osascript, Windows through scripts/windows/toast.ps1 (WinRT toast),
// Linux through notify-send. All best-effort — a missing helper or command
// must never take the pipeline down.
import { existsSync } from "node:fs";
import { execFile as nodeExecFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_APP = join(ROOT, "Jobs.app"); // built by build-jobs.sh (macOS only)
const TOAST_PS1 = join(ROOT, "scripts", "windows", "toast.ps1");

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Per-platform banner command. Title/message ride as argv entries, never a
// shell string — they carry scraped job-board text.
export function notifyCommand(title, message, platform) {
  if (platform === "win32") {
    return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TOAST_PS1, "-Title", title, "-Message", message]];
  }
  if (platform === "linux") return ["notify-send", [title, message]];
  return ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]];
}

// Banner on any platform; best-effort, never throws.
// (macOS: terminal-notifier shows no banners on macOS 26, hence osascript.)
export function notify(title, message, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = notifyCommand(title, message, platform);
  try { exec(cmd, args, () => {}); } catch {}
}
```

In `ensureJobsApp`, add as the FIRST line:

```js
  if (process.platform !== "darwin") return; // the Jobs.app badge daemon is macOS-only
```

(The rest of `ensureJobsApp` is unchanged; `JOBS_APP` now derives from `ROOT` — same resolved path as before.)

Create `lib/open.mjs`:

```js
// Cross-platform "open this file/URL in the default app". Best-effort,
// never throws — opening a browser is a convenience, not a requirement.
import { execFile as nodeExecFile } from "node:child_process";

export function openCommand(target, platform) {
  if (platform === "win32") return ["cmd", ["/c", "start", "", target]]; // "" = window title slot
  if (platform === "darwin") return ["open", [target]];
  return ["xdg-open", [target]];
}

export function openPath(target, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = openCommand(target, platform);
  try { exec(cmd, args, () => {}); } catch {}
}
```

In `dashboard.mjs`: replace the import line `import { execFile } from "node:child_process";` with `import { openPath } from "./lib/open.mjs";` (execFile has no other use in the file — verify with grep), and replace the last block's `execFile("open", [OUT], () => {});` with `openPath(OUT);`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/notify.test.mjs test/open.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite, macOS smoke, commit**

Run: `node --test test/` — all PASS.
Run: `node --check dashboard.mjs lib/notify.mjs lib/open.mjs` (three separate `node --check <file>` calls).
macOS smoke (this machine): `node -e "import('./lib/notify.mjs').then(m => m.notify('Windows-support test', 'dispatch works'))"` — a banner appears; `node dashboard.mjs --open` still opens the page.

```bash
git add lib/notify.mjs lib/open.mjs dashboard.mjs test/notify.test.mjs test/open.test.mjs
git commit -m "feat: cross-platform notify/open dispatch (osascript | powershell toast | notify-send)"
```

---

### Task 2: Windows PowerShell shell — `scripts/windows/`

**Files:**
- Create: `scripts/windows/toast.ps1`, `scripts/windows/tray-badge.ps1`, `scripts/windows/open-dashboard.ps1`, `scripts/windows/register-tasks.ps1.example`, `scripts/windows/run.ps1.example`, `scripts/windows/run-jobs.ps1.example`
- Modify: `.gitignore` (three filled-in copies)

**Interfaces:**
- Consumes: `notifyCommand`'s win32 contract from Task 1 — `toast.ps1` MUST accept `-Title <string> -Message <string>`.
- Produces: the six scripts; Task 3's CI parses them; Task 4's README references their paths verbatim.

No unit tests (PowerShell is not runnable from node:test); verification is a parse check here, the CI parse gate in Task 3, and the manual checklist in Task 4's README.

- [ ] **Step 1: `scripts/windows/toast.ps1`**

```powershell
# Windows 10/11 toast banner via WinRT — no modules, no dependencies.
# Called by lib/notify.mjs as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Title t -Message m
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = "Stop"
# PowerShell's own AppUserModelID — lets the toast show without registering an app.
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$escTitle = [System.Security.SecurityElement]::Escape($Title)
$escMessage = [System.Security.SecurityElement]::Escape($Message)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$escTitle</text><text>$escMessage</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
  [Windows.UI.Notifications.ToastNotification]::new($xml))
```

- [ ] **Step 2: `scripts/windows/tray-badge.ps1`**

```powershell
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
```

- [ ] **Step 3: `scripts/windows/open-dashboard.ps1`**

```powershell
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
```

- [ ] **Step 4: `scripts/windows/run.ps1.example` and `run-jobs.ps1.example`**

`run.ps1.example` (inbox check wrapper):

```powershell
# Wrapper for the scheduled LinkedIn inbox check (mirror of run.sh.example).
# Copy to run.ps1 (gitignored) and fill in your own values.
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;" + $env:Path   # adjust if node lives elsewhere
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))   # repo root

$env:RESUME_PATH = "$env:USERPROFILE\Downloads\your-resume.docx"
$env:CANDIDATE_NAME = "Your Name"

New-Item -ItemType Directory -Force -Path logs | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
node check.mjs *>> "logs\check_$stamp.log"
```

`run-jobs.ps1.example` (job discovery wrapper):

```powershell
# Wrapper for scheduled job discovery (mirror of run-jobs.sh.example).
# Arg: -Mode dou (RSS/API sources only) or -Mode full (adds LinkedIn scraping).
# Copy to run-jobs.ps1 (gitignored) and fill in your own values.
param([string]$Mode = "full")
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;" + $env:Path   # adjust if node lives elsewhere
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))   # repo root

$env:RESUME_PATH = "$env:USERPROFILE\Downloads\your-resume.docx"
$env:CANDIDATE_NAME = "Your Name"
# Free Jooble API key from https://jooble.org/api/about (only if jooble.enabled)
$env:JOOBLE_API_KEY = "your-jooble-api-key"

New-Item -ItemType Directory -Force -Path logs | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
if ($Mode -eq "dou") {
  $env:DOU_ONLY = "1"
  node jobs.mjs *>> "logs\jobs_dou_$stamp.log"
} else {
  node jobs.mjs *>> "logs\jobs_full_$stamp.log"
}
```

- [ ] **Step 5: `scripts/windows/register-tasks.ps1.example`**

```powershell
# Registers the scheduled tasks — the Task Scheduler mirror of the launchd
# plists. Copy to register-tasks.ps1 (gitignored), set $Repo, then run from
# an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File register-tasks.ps1
# Uninstall: Unregister-ScheduledTask -TaskName "linkedin-assistant *"
$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run from an elevated PowerShell — Task Scheduler registration needs admin."
}

$Repo = "C:\Users\YOUR_USERNAME\linkedin-assistant"
$Win = Join-Path $Repo "scripts\windows"
$forever = New-TimeSpan -Days 3650

function Register-Job([string]$Name, [string]$Arguments, $Trigger) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass $Arguments" -WorkingDirectory $Repo
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Force | Out-Null
  Write-Host "registered: $Name"
}

# Inbox check — hourly (mirror of com.*.linkedin-assistant.plist)
Register-Job "linkedin-assistant inbox" "-File `"$Win\run.ps1`"" `
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration $forever)

# DOU/Djinni/Jooble discovery — hourly (mirror of com.*.job-discovery-dou.plist)
Register-Job "linkedin-assistant discovery-dou" "-File `"$Win\run-jobs.ps1`" -Mode dou" `
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration $forever)

# LinkedIn discovery — every 3 hours at :45 (mirror of com.*.job-discovery-linkedin.plist)
Register-Job "linkedin-assistant discovery-linkedin" "-File `"$Win\run-jobs.ps1`" -Mode full" `
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(45) -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration $forever)

# Follow-up reminders — daily at 10:00 (mirror of com.*.jobs-followup.plist)
Register-Job "linkedin-assistant followup" "-Command `"Set-Location '$Repo'; node followup.mjs`"" `
  (New-ScheduledTaskTrigger -Daily -At 10:00)

# Tray badge — at logon (mirror of com.*.jobs-badge.plist)
Register-Job "linkedin-assistant tray-badge" "-WindowStyle Hidden -File `"$Win\tray-badge.ps1`"" `
  (New-ScheduledTaskTrigger -AtLogOn)
```

- [ ] **Step 6: `.gitignore` additions**

Append (next to the run.sh / com.*.plist block):

```
# Machine-specific Windows wrappers & task registration — use the *.example templates
scripts/windows/run.ps1
scripts/windows/run-jobs.ps1
scripts/windows/register-tasks.ps1
```

- [ ] **Step 7: Verify + commit**

Parse every script on macOS (pwsh is not installed here — use Node to at least confirm the files exist and carry no `</script>`-style accidents; the REAL parse gate is Task 3's CI):

Run: `ls scripts/windows/` → six files.
Run: `node --test test/` — all PASS (nothing in test/ touches the new scripts).

```bash
git add scripts/windows .gitignore
git commit -m "feat: Windows shell — WinRT toast, tray unread badge, Task Scheduler templates, run wrappers"
```

---

### Task 3: CI — `.github/workflows/test.yml`

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: the repo's test suite; Task 2's `scripts/windows/*.ps1*` (parse gate).
- Produces: the PR check future work relies on.

- [ ] **Step 1: Create the workflow**

```yaml
name: tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # Tests never launch a browser — plain npm ci, no playwright install.
      - run: npm ci
      - run: node --test test/
      - name: Syntax-check every module
        shell: bash
        run: |
          set -e
          for f in *.mjs lib/*.mjs lib/sources/*.mjs; do node --check "$f"; done
      - name: Dashboard smoke build
        shell: bash
        run: |
          set -e
          mkdir -p applications
          node dashboard.mjs
          grep -q "statusOfEntry" applications/index.html
      - name: Parse PowerShell scripts
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $bad = @()
          Get-ChildItem scripts/windows -File | ForEach-Object {
            $tokens = $null; $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
            if ($errors) { $bad += $_.Name; $errors | ForEach-Object { Write-Host "$($_.Extent.File): $($_.Message)" } }
          }
          if ($bad) { throw "PowerShell parse errors in: $($bad -join ', ')" }
```

- [ ] **Step 2: Verify locally what can be verified**

Sanity-check the file landed with the matrix in place:
`node -e "const s=require('fs').readFileSync('.github/workflows/test.yml','utf8'); for (const os of ['ubuntu-latest','macos-latest','windows-latest']) if(!s.includes(os)) throw new Error('missing '+os); console.log('ok')"`.
The real verification is the Actions run on the PR this branch opens — check all three OS jobs are green there before merging.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run the suite on ubuntu/macos/windows; parse PowerShell scripts on Windows"
```

---

### Task 4: README — "Windows" section (EN + UK)

**Files:**
- Modify: `README.md` (new section AFTER the "## Schedule it (launchd)" section), `README.uk.md` (mirror AFTER "## Розклад (launchd)")

**Interfaces:**
- Consumes: script paths and task names from Task 2 verbatim.
- Produces: docs only.

- [ ] **Step 1: README.md**

Insert after the launchd section (before "## When it breaks"):

```markdown
## Windows

The Node core — discovery, scoring, LLM letters, packages, the dashboard with
its state server — is cross-platform and needs no extras: the one-time setup
above works as-is (`npm install`, `npx playwright install chromium`,
`node login.mjs`), then `node jobs.mjs` / `node check.mjs` / `node
dashboard.mjs --open` behave exactly like on macOS. Notifications dispatch
per-platform automatically (macOS: osascript banner, Windows: WinRT toast,
Linux: notify-send) and are always best-effort.

The optional Windows shell lives in `scripts\windows\`:

- **Toasts** — used automatically by every script once the repo is cloned
  (`toast.ps1` is invoked by `lib/notify.mjs` on win32). Try it:
  `powershell -ExecutionPolicy Bypass -File scripts\windows\toast.ps1 -Title Hi -Message "it works"`.
- **Tray unread badge** (the Dock-badge analog) —
  `powershell -ExecutionPolicy Bypass -File scripts\windows\tray-badge.ps1`:
  a tray icon with the summed LinkedIn+Djinni unread count, left-click opens
  the dashboard. Registered at logon by the scheduler script below.
- **Dashboard shortcut** — `scripts\windows\open-dashboard.ps1` rebuilds the
  page, starts the state server if needed, opens the browser.
- **Scheduling** — copy `run.ps1.example` / `run-jobs.ps1.example` /
  `register-tasks.ps1.example` without the `.example` suffix, fill in your
  paths, then run `register-tasks.ps1` from an **elevated** PowerShell. It
  registers the same cadence as the launchd setup: inbox hourly, DOU
  discovery hourly, LinkedIn discovery every 3 h at :45, follow-ups daily,
  tray badge at logon. The filled-in copies are gitignored.

Limitations: there is no taskbar overlay badge (the tray icon is the analog),
and the toast/tray scripts are best-effort — CI parses them on a real Windows
runner, but banners are inherently visual; the one-line toast test above is
the manual check.
```

- [ ] **Step 2: README.uk.md mirror**

Insert after the «Розклад (launchd)» section:

```markdown
## Windows

Node-ядро — пошук, скоринг, LLM-листи, пакети, дашборд із сервером стану —
кросплатформене і не потребує нічого додаткового: одноразове налаштування
вище працює як є (`npm install`, `npx playwright install chromium`,
`node login.mjs`), далі `node jobs.mjs` / `node check.mjs` /
`node dashboard.mjs --open` поводяться так само, як на macOS. Сповіщення
самі обирають платформу (macOS: банер osascript, Windows: WinRT-тост,
Linux: notify-send) і завжди best-effort.

Опційна Windows-обгортка живе у `scripts\windows\`:

- **Тости** — використовуються автоматично (`toast.ps1` викликає
  `lib/notify.mjs` на win32). Перевірити:
  `powershell -ExecutionPolicy Bypass -File scripts\windows\toast.ps1 -Title Hi -Message "працює"`.
- **Трей-бейдж непрочитаного** (аналог Dock-бейджа) —
  `powershell -ExecutionPolicy Bypass -File scripts\windows\tray-badge.ps1`:
  іконка в треї з сумою непрочитаних LinkedIn+Djinni, лівий клік відкриває
  дашборд. Реєструється на логоні скриптом розкладу нижче.
- **Ярлик дашборда** — `scripts\windows\open-dashboard.ps1` перебудовує
  сторінку, за потреби стартує сервер стану, відкриває браузер.
- **Розклад** — скопіюйте `run.ps1.example` / `run-jobs.ps1.example` /
  `register-tasks.ps1.example` без суфікса `.example`, заповніть свої шляхи
  і запустіть `register-tasks.ps1` з **підвищеної** PowerShell. Реєструється
  той самий розклад, що й у launchd: скринька щогодини, DOU щогодини,
  LinkedIn кожні 3 год о :45, фолоу-апи щодня, трей-бейдж на логоні.
  Заповнені копії — у gitignore.

Обмеження: оверлей-бейджа на панелі задач немає (аналог — іконка в треї), а
тост/трей — best-effort: CI парсить скрипти на справжньому Windows-раннері,
але банери за природою візуальні; ручна перевірка — команда тосту вище.
```

- [ ] **Step 3: Verify + commit**

Run: `node --test test/` — all PASS.

```bash
git add README.md README.uk.md
git commit -m "docs: Windows section — toasts, tray badge, Task Scheduler setup (EN + UK)"
```
