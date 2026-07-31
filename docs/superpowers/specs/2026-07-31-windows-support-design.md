# Windows support — design

Date: 2026-07-31
Status: approved

## Goal

The Node core (scraping, scoring, LLM, packages, dashboard + state server)
already runs on Windows; the convenience shell is macOS-native: launchd
scheduling, osascript/Notifier.app banners, the Jobs.app Dock badge, and the
`open` command. Bring Windows to practical parity: toast notifications, a
tray-icon unread badge, Task Scheduler templates, and cross-platform
dashboard opening — plus CI that actually runs the suite on Windows.

Decisions from brainstorming: all four shell pieces are in scope; the Dock
badge's Windows analog is a system-tray icon with a drawn unread count (a
taskbar overlay badge would need a real app — rejected); verification is
GitHub Actions CI on windows-latest (+ macos + ubuntu), with the visual
pieces (toast, tray) shipped best-effort behind a manual checklist in the
docs, since headless CI cannot see them.

## Approach

Platform dispatch inside the existing modules; everything Windows-specific is
PowerShell under `scripts/windows/` (no compile step, no npm dependencies —
PowerShell + built-in .NET only). The macOS path stays byte-identical.

## 1. `lib/notify.mjs` — platform dispatch

`notify(title, message)` dispatches on platform (injectable `platform` and
`exec` params, defaulting to `process.platform`/`execFile`, for tests):

- `darwin` — osascript, exactly as today.
- `win32` — `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/toast.ps1 <title> <message>` (args passed as argv, never shell-interpolated — titles contain scraped job text).
- `linux` — `notify-send <title> <message>` (freebie: best-effort like the rest).

All paths remain best-effort and never throw. `ensureJobsApp()` returns
immediately on non-darwin (the Jobs.app daemon is macOS-only by definition).
`log()` unchanged.

## 2. `lib/open.mjs` — cross-platform "open"

`openPath(target, { platform, exec } = {})` (~12 lines): `darwin` → `open
<target>`; `win32` → `cmd /c start "" <target>`; other → `xdg-open <target>`.
Best-effort, never throws. `dashboard.mjs --open` switches to it. The
macOS-only call sites (Notifier.app spawn in `jobs.mjs`, `open-dashboard.sh`)
are already behind `existsSync`/platform guards and stay as-is.

## 3. `scripts/windows/` — PowerShell shell

- **`toast.ps1`** — Win10/11 toast via WinRT
  (`Windows.UI.Notifications.ToastNotificationManager`), no modules required.
  Takes `-Title` and `-Message` params.
- **`tray-badge.ps1`** — the Jobs.app mirror: WinForms `NotifyIcon`; every
  ~3 s reads `notify-state.json` + `djinni-notify-state.json` (same
  `readState` shape the Swift app reads), sums the counts, draws the number
  into a 16×16 GDI bitmap icon (plain briefcase glyph when zero); left-click
  opens `http://127.0.0.1:7777/` via `Start-Process`; right-click menu with
  Exit. Runs as a normal PowerShell process the user starts at login
  (registered by the scheduler template below).
- **`open-dashboard.ps1`** — mirror of `open-dashboard.sh`: rebuild
  `dashboard.mjs`, start `state-server.mjs` if 7777 is not listening, open
  the browser.
- **`register-tasks.ps1.example`** — registers the Task Scheduler entries
  (mirrors the launchd plists): inbox check hourly, DOU discovery hourly,
  LinkedIn discovery every 3 h at :45, follow-up daily, tray badge at logon.
  Ships as `.example` (machine-specific paths), like the plists.
- **`run.ps1.example` / `run-jobs.ps1.example`** — mirrors of the `.sh`
  wrappers: `$env:RESUME_PATH`, `$env:CANDIDATE_NAME`, `$env:JOOBLE_API_KEY`,
  logging to `logs\`, `node check.mjs` / `node jobs.mjs`.

Gitignore: `scripts/windows/run.ps1`, `scripts/windows/run-jobs.ps1`,
`scripts/windows/register-tasks.ps1` (the filled-in copies), matching the
`.sh`/plist convention.

## 4. CI — `.github/workflows/test.yml`

The repo's first CI. Matrix: `ubuntu-latest`, `macos-latest`,
`windows-latest`; Node 20. Steps: `npm ci`; `node --test test/`;
`node --check` on every root `.mjs` and `lib/**/*.mjs`; dashboard smoke build
(`mkdir applications` → `node dashboard.mjs` → grep the generated HTML for
the inlined client marker); on the Windows runner additionally parse every
`scripts/windows/*.ps1*` with the PowerShell language parser
(`[System.Management.Automation.Language.Parser]::ParseFile`, fail on
errors). Trigger: `push` to main and `pull_request`. This becomes the PR
gate for the public repo.

Playwright note: tests import only `lib/` modules that don't launch
browsers, so `npm ci` suffices — no `playwright install` in CI.

## 5. Tests

- `test/notify.test.mjs` — dispatch with injected `platform`/`exec`: darwin →
  `osascript` with the AppleScript body; win32 → `powershell` with
  `-File …toast.ps1` and the title/message as separate argv entries; linux →
  `notify-send`; exec error → resolves without throwing.
- `test/open.test.mjs` — per-platform command/args; error → no throw.

The tray/toast PowerShell behavior itself is not unit-testable from Node —
covered by the CI syntax parse plus the manual checklist in the README.

## 6. Docs — README section "Windows" (EN + UK)

Setup (Node + `npm install` + `npx playwright install chromium` +
`node login.mjs` — unchanged), what works out of the box, then the shell:
toasts (automatic once `scripts/windows/toast.ps1` exists), tray badge
(`powershell -File scripts\windows\tray-badge.ps1`), scheduling
(`register-tasks.ps1.example` copy-edit-run, elevated), dashboard shortcut.
Honest limitations: no Dock-style overlay badge (tray analog instead);
toast/tray are best-effort — a short manual verification checklist (run
toast.ps1 by hand, see the banner; start tray-badge.ps1, see the count).
State that the whole shell is optional: `node jobs.mjs` + the dashboard work
with zero Windows extras.

## Error handling

- Notifications/open: best-effort on every platform — exec errors are
  swallowed (existing contract).
- `tray-badge.ps1`: unreadable/missing state files → count 0, keep polling.
- `register-tasks.ps1`: requires elevation; fails loudly with a clear message
  when not elevated.

## Out of scope

- Taskbar overlay badge (Teams-style) — needs a packaged app.
- WSL-specific instructions (native Windows is the target).
- Auto-elevation or an installer.

## Implementation order

1. `lib/notify.mjs` dispatch + `lib/open.mjs` + tests (pure Node, fully
   unit-tested)
2. `scripts/windows/` PowerShell set (toast, tray, open-dashboard, task
   registration, run wrappers) + gitignore entries
3. CI workflow (all three OSes; PowerShell parse on Windows)
4. README EN + UK

Steps 1 and 3 are machine-verifiable; step 2's visual behavior ships
best-effort with the documented manual checklist.
