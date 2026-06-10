# Design: Unread LinkedIn message badge on the Notifier app

**Date:** 2026-06-10
**Status:** Approved

## Goal

Show a persistent red badge with a count of unread LinkedIn message threads on
the Dock icon — the macOS equivalent of the iPhone "Messages" home-screen badge.
Today only a transient banner is shown; there is no count badge.

## Approach (decided)

Extend the **existing** `Notifier.app` — do **not** create a separate app.
The same app gains a persistent Dock presence and a badge, while keeping its
current banner behaviour.

Today `Notifier.app` is `LSUIElement` (no Dock icon) and one-shot: it is
launched per message (`open -n -a Notifier.app --args title body`), posts one
banner, and exits after ~8 s. A Dock badge needs a process that stays alive and
owns a Dock tile, so the app becomes a long-running, Dock-present app.

## Components

### 1. `notifier.swift` — two modes in one binary

- **Daemon mode** (launched with no banner args, started at login):
  - Regular activation policy (`.regular`) instead of `LSUIElement`, so the app
    shows in the Dock with the green Messages icon.
  - No window. Runs an `NSApplication` run loop.
  - Every ~3 s reads the state file `notify-state.json` and:
    - sets `NSApp.dockTile.badgeLabel` to the unread count (empty string when 0,
      so the badge disappears);
    - for any `pending` banner entries not yet delivered, posts them via
      `UserNotifications` (same code path as today) and marks them delivered.
  - On reopen/click of the Dock icon, opens `https://www.linkedin.com/messaging/`
    via `NSWorkspace`.
- **Banner mode** (`notifier "title" "body"`): unchanged one-shot banner, kept
  for the manual test in `build-notifier.sh`. Not used by the runtime path.
- `--status` flag: unchanged.

### 2. `build-notifier.sh` — packaging changes

- Remove `LSUIElement` from `Info.plist` (Dock icon appears).
- Keep the same `CFBundleIdentifier` and ad-hoc signing so the granted
  notification permission is preserved.
- Green Messages icon build is reused as-is.

### 3. `check.mjs` — produce state instead of spawning per message

- Count **all** unread threads using the existing `cardIsUnread` helper,
  independent of `SCAN_ALL` and the job-relevance filter.
- Replace the per-message `open -n -a Notifier.app --args ...` with a single
  write to `notify-state.json`:
  ```json
  {
    "count": 2,
    "pending": [
      { "id": "thread-id-or-hash", "sender": "Helen", "text": "..." }
    ],
    "updatedAt": "2026-06-10T10:00:00.000Z"
  }
  ```
  - `count` is the total unread-thread count (drives the badge).
  - `pending` carries new-message banners for the daemon to post. Entry `id`
    reuses the existing `threadId` so the same message is not re-bannered.
- Defensively ensure the daemon is running: `open -g -j -a Notifier.app`
  (no-op if already running; `-g` keeps focus, `-j` launches hidden).

### 4. Autostart

- Add a LaunchAgent plist (modelled on the existing `com.eugene.*.plist`) that
  launches `Notifier.app` at login and keeps it alive, so the badge is always
  present.

## Data flow

```
LaunchAgent (schedule) -> check.mjs -> counts unread threads
        -> writes notify-state.json { count, pending }
Notifier.app (always in Dock) -> every ~3s reads notify-state.json
        -> NSApp.dockTile.badgeLabel = "<count>"   (red badge)
        -> posts any new pending banners (UserNotifications)
Click on Dock icon -> opens linkedin.com/messaging/
```

## Decisions

- **Badge number** = all unread threads (matches LinkedIn's own counter), not
  just job-relevant ones.
- **Click clears badge?** No optimistic clear. Clicking only opens LinkedIn; the
  badge is reconciled by the next scan (a few minutes), keeping the number
  honest rather than briefly wrong.
- **One app**, not two. Banners and badge live in the same `Notifier.app`.

## Out of scope (YAGNI)

- No change to banner appearance.
- No real-time push; the badge updates on the existing scan cadence (plus the
  ~3 s file poll for prompt pickup).
- No badge interaction beyond open-on-click.

## Risk notes

- Removing `LSUIElement` keeps the same bundle id, so notification permission is
  preserved; no re-grant needed.
- Two-instance hazard (a daemon plus a one-shot `-n` banner) is avoided by
  routing banners through the daemon via `notify-state.json` instead of
  `open -n` per message.
- `notify-state.json` is written by `check.mjs` and read by the daemon; writes
  should be atomic (write temp + rename) to avoid the daemon reading a partial
  file.
