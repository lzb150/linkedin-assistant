# Design: Unread LinkedIn message badge on the Jobs app

**Date:** 2026-06-10
**Status:** Approved (revised v2 — badge moved to Jobs.app)

## Goal

Show a persistent red badge with a count of unread LinkedIn message threads on
the **`Jobs.app`** ("Вакансии") Dock icon — the macOS equivalent of the iPhone
"Messages" home-screen badge. Only the badge is wanted; no banner pop-ups.

## Approach (decided)

The badge lives on the **`Jobs.app`** icon (the launcher the user keeps in the
Dock), not a separate notifier app.

`Jobs.app` is today an AppleScript applet that runs `node dashboard.mjs --open`
and quits. A Dock badge requires a process that stays alive and owns its Dock
tile, and a one-shot applet cannot hold a live count. AppleScript "stay-open"
applets cannot be produced reliably from the CLI (`osacompile` builds run-once
applets only). Therefore `Jobs.app` is **rebuilt as a small Swift app** that:

- stays running in the Dock with the existing "Вакансии" icon;
- polls `notify-state.json` every ~3 s and sets the Dock badge to the unread
  count (cleared at 0);
- opens the dashboard (`node dashboard.mjs --open`) on a foreground (user)
  launch and on Dock-icon click — preserving the old applet's behaviour;
- when launched with `--background` (login LaunchAgent / `check.mjs`) runs the
  badge daemon only and does NOT open the dashboard.

`Jobs.app` is a git-ignored build artifact (like `Notifier.app`), so rebuilding
it from a script + committed sources fits the repo. Banners are dropped, so the
separate `Notifier.app` is no longer used (left in the repo, dormant).

## Components

### 1. `notifier.swift` — two modes in one binary

- **Daemon mode** (launched with no banner args, started at login):
### Components

**1. `jobs-app.swift` (new) — the Jobs launcher + badge daemon**
- Regular activation policy (`.regular`); no window; runs an `NSApplication`
  run loop and stays in the Dock with the "Вакансии" icon.
- Every ~3 s reads `notify-state.json` and sets `NSApp.dockTile.badgeLabel` to
  the `count` (set to `nil` when 0, so the badge disappears).
- `applicationDidFinishLaunching`: starts the poll timer; on a foreground launch
  (no `--background` arg) also opens the dashboard once.
- `applicationShouldHandleReopen` (Dock-icon click while running): opens the
  dashboard.
- Opening the dashboard runs `node dashboard.mjs --open` (node path resolved
  from `$NODE_BIN`, then `~/.nvm/.../v20.14.0/bin/node`, then Homebrew, then
  `env node`).

**2. `build-jobs.sh` (new) — packaging**
- Compiles `jobs-app.swift` into `Jobs.app/Contents/MacOS/jobs`.
- `Info.plist`: `CFBundleName`/`CFBundleDisplayName` = "Вакансии",
  `CFBundleIdentifier` = `com.eugene.linkedin-assistant.jobs`, icon = `AppIcon`,
  no `LSUIElement`.
- Copies `jobs.icns` (extracted from the old applet, committed) to
  `Resources/AppIcon.icns`.
- Ad-hoc signs and registers with LaunchServices.

**3. `check.mjs` — write the count, drop banners**
- Counts **all** unread threads via the existing `cardIsUnread` helper,
  independent of `SCAN_ALL` and the job-relevance filter.
- Removes the per-message banner call (`notifyMessage`) — banners are dropped.
- Writes `notify-state.json` via the helper: `{ "count": N, "updatedAt": "..." }`.
- Defensively ensures `Jobs.app` is running: `open -g -a Jobs.app --args --background`
  (no-op if already running; `--background` means "don't open the dashboard").
- Keeps the existing `notify()` osascript call for the session-expired alert.

**4. Autostart**
- LaunchAgent plist `com.eugene.jobs-badge.plist` (modelled on the existing
  `com.eugene.*.plist`) runs `open -g -a Jobs.app --args --background` at login,
  so the badge daemon is always present without opening the dashboard.

## Data flow

```
LaunchAgent (login) -> open -g -a Jobs.app --args --background  (badge daemon)
check.mjs (scan) -> counts unread threads -> writes notify-state.json { count }
Jobs.app (always in Dock) -> every ~3s reads notify-state.json
        -> NSApp.dockTile.badgeLabel = "<count>"   (red badge, nil when 0)
Click on Dock icon -> opens the jobs dashboard (node dashboard.mjs --open)
```

## Decisions

- **Badge number** = all unread threads (matches LinkedIn's own counter).
- **Only the badge** — no banner pop-ups (the former `Notifier.app` path is
  dropped from `check.mjs`; the app is left dormant in the repo).
- **Badge lives on Jobs.app**, the icon the user already keeps in the Dock.
- **No optimistic clear** — the badge is reconciled by the next scan, keeping the
  number honest.

## Out of scope (YAGNI)

- No banners.
- No real-time push; the badge updates on the scan cadence plus the ~3 s poll.
- No badge interaction beyond open-dashboard-on-click.

## Risk notes

- A Dock badge requires a running app owning the Dock tile; hence `Jobs.app`
  must stay open and be autostarted. A one-shot/closed app cannot show a live
  badge.
- `notify-state.json` is written by `check.mjs` and read by `Jobs.app`; writes
  are atomic (temp + rename) so the reader never sees a partial file.
- The old applet `Jobs.app` is backed up to `Jobs.app.orig` before replacement.
- `check.mjs` opens unread threads (may mark them read on LinkedIn); the count is
  taken at scan start, so the badge tracks LinkedIn's own read-state over scans.
