# Design: Unread Djinni inbox count in the combined Dock badge

**Date:** 2026-06-10
**Status:** Approved
**Builds on:** [Unread LinkedIn message badge](2026-06-10-linkedin-message-badge-design.md) (PR #1)

## Goal

Add the count of unread message threads at `https://djinni.co/my/inbox/` to the
existing red `Jobs.app` ("Вакансии") Dock badge. The badge becomes a **combined**
counter: unread LinkedIn message threads **plus** unread Djinni inbox threads.
This mirrors PR #1's mechanism for a second source. Count only — no reply
drafting, no relevance scoring, no banners.

## Approach (decided)

Two independent checkers, one shared badge daemon:

- Each checker is the **sole writer of its own state file**, so the atomic
  single-writer guarantee from `lib/notify-state.mjs` (temp file + rename) holds
  per file and the two schedulers never race on one file.
  - `check.mjs`        → `notify-state.json`         (LinkedIn, existing)
  - `djinni-check.mjs` → `djinni-notify-state.json`  (Djinni, new)
- `Jobs.app` polls **both** files every ~3 s and sets the Dock badge to the
  **sum** of their counts (cleared at 0).

Rejected alternative: one merged state file written by both checkers. It would
require cross-process locking to keep each source's count independent; two files
+ sum-in-Swift avoids that entirely and is trivially debuggable.

The Djinni session is kept in its own browser profile (`.djinni-profile/`),
separate from LinkedIn's `.browser-profile/`.

## Data flow

```
LaunchAgent (login)  -> open -g -a Jobs.app --args --background   (badge daemon)
check.mjs        (hourly) -> counts LinkedIn unread -> notify-state.json        { count }
djinni-check.mjs (hourly) -> counts Djinni  unread -> djinni-notify-state.json  { count }
Jobs.app (always in Dock) -> every ~3s reads BOTH files
        -> NSApp.dockTile.badgeLabel = "<linkedinCount + djinniCount>"  (nil when 0)
Dock-icon click -> opens the jobs dashboard (node dashboard.mjs --open)  [unchanged]
```

## Components

### 1. `djinni-login.mjs` (new) — one-time / re-auth login

Modelled on `login.mjs`. Opens a real (headful) browser to
`https://djinni.co/login`, the user logs in manually (including 2FA). It never
sees or stores the password; it only persists the browser session into
`.djinni-profile/`. Auto-detects a successful login, then saves and closes.
Times out after ~6 minutes.

- **Login detection** (any one is enough):
  - a Djinni session cookie is present (e.g. `sessionid`), OR
  - an authenticated nav element is visible (user menu / logout / messages icon),
    OR the URL has left `/login` for an authenticated path (`/my/...`).
- Run: `node djinni-login.mjs`.

### 2. `djinni-check.mjs` (new) — count unread, write state

Modelled on `check.mjs` but **count-only** (no thread opening, no drafting, no
banners — so it does not risk marking Djinni threads read).

- Reuses `.djinni-profile`; launches headless (`HEADFUL=1` to watch).
- Navigates to `https://djinni.co/my/inbox/`.
- **Logged-out detection:** if redirected to `/login` (or the inbox container is
  absent and a login form is present), log a clear message
  (`run: node djinni-login.mjs`), fire the existing osascript session-expired
  alert, and exit with code 2 — same shape as `check.mjs`.
- **Unread counting — layered strategy** (Djinni is server-rendered and does not
  obfuscate classes, but selectors still need live verification):
  1. **Primary:** read Djinni's own unread counter in the top nav (the
     messages/envelope badge). If present and numeric, use it directly — it is
     the site's own source of truth.
  2. **Fallback:** count inbox thread rows that carry an unread marker
     (unread CSS class, an unread/new badge on the row, or a bold thread title).
  - Selectors are centralized in a `SEL` object at the top of the file with a
    comment that they may need updating, exactly like `check.mjs`.
- Writes `djinni-notify-state.json` via `writeState` from `lib/notify-state.mjs`:
  `{ "count": N, "updatedAt": "..." }`.
- Defensively ensures `Jobs.app` is running
  (`open -g -a Jobs.app --args --background`; no-op if already up), reusing the
  same helper logic as `check.mjs`.
- Honours `HEADFUL=1` for selector debugging.

### 3. `jobs-app.swift` (changed) — badge the sum of both sources

`poll()` reads **both** `notify-state.json` and `djinni-notify-state.json`,
extracts each `count` (missing/invalid file → 0), and sets
`NSApp.dockTile.badgeLabel` to the **sum** as a string (`nil` when the sum is 0).
A small helper reads one state file's count so the two reads share code. Header
comment updated to say the badge reflects LinkedIn + Djinni unread. No change to
launch behaviour, dashboard-open, or `build-jobs.sh`; rebuild with the existing
`./build-jobs.sh`.

### 4. Autostart & scheduling (new templates)

- `run-djinni.sh.example` — scheduled wrapper modelled on `run.sh`: sets an
  explicit `PATH` (launchd strips it), `cd`s to the project, runs
  `node djinni-check.mjs` and logs to `logs/`.
- `com.example.djinni-inbox.plist.example` — LaunchAgent modelled on
  `com.eugene.linkedin-assistant.plist`: runs `run-djinni.sh` **hourly**
  (`StartCalendarInterval` minute 0), logging to `logs/`. `RunAtLoad` false.
- The badge daemon itself needs **no new LaunchAgent** — the existing
  `com.eugene.jobs-badge.plist` already starts `Jobs.app`, which now reads both
  state files.

### 5. `.gitignore` (changed)

Add the Djinni machine-local artifacts, alongside the existing LinkedIn ones:

- `.djinni-profile/` (logged-in cookies — never commit)
- `djinni-notify-state.json` and `djinni-notify-state.json.tmp`
- `run-djinni.sh` (real wrapper; the `*.example` template is committed)

(`com.*.plist` is already ignored, so the real LaunchAgent is covered.)

### 6. `README.md` (changed)

Document: `node djinni-login.mjs` (one-time), `node djinni-check.mjs`, the
combined badge (LinkedIn + Djinni), and installing the hourly Djinni LaunchAgent
from the `.example` template.

## Testing

- `lib/notify-state.mjs` is reused unchanged; its existing `node --test` suite
  (`test/notify-state.test.mjs`) already covers atomic read/write and is the
  contract `djinni-check.mjs` writes against. No new unit test is required for a
  count-only scraper; correctness of selectors is verified live via
  `HEADFUL=1 node djinni-check.mjs`.
- Manual verification (mirrors PR #1's test plan):
  - `node djinni-login.mjs` → log in → session saved to `.djinni-profile`.
  - `HEADFUL=1 node djinni-check.mjs` → confirm selectors find the unread count;
    wrote `djinni-notify-state.json { count: N }`.
  - With both state files present, the `Jobs.app` badge shows the **sum**;
    setting either count to 0 reduces the badge; both 0 → badge cleared.
  - Hourly LaunchAgent loads (`launchctl load`) without error.

## Out of scope (YAGNI)

- No reply drafting or relevance scoring for Djinni (count only).
- No banner pop-ups.
- No separate Djinni Dock icon — the count folds into the existing `Jobs.app`.
- No real-time push; the badge updates on the hourly scan plus the ~3 s poll.

## Risk notes

- **Selectors unverified at design time:** the author cannot authenticate to
  Djinni, so the primary/fallback selectors are best-effort and must be
  confirmed once with `HEADFUL=1 node djinni-check.mjs`. The layered strategy and
  centralized `SEL` block make this a one-line fix if the DOM differs.
- **Reading vs. marking read:** `djinni-check.mjs` only reads the inbox list /
  nav counter and never opens threads, so it does not change Djinni's read state
  (unlike `check.mjs`, which opens LinkedIn threads).
- **Combined badge ambiguity:** a single number cannot show which source the
  unread came from. Accepted per the chosen design (one combined badge).
- Writes remain atomic (temp + rename) so `Jobs.app` never reads a partial file;
  reading two files independently means a transient mismatch at most lasts one
  ~3 s poll.
