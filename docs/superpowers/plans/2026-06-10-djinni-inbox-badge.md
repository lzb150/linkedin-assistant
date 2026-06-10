# Djinni Inbox Unread Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the count of unread `djinni.co/my/inbox/` threads to the existing red `Jobs.app` Dock badge, so it shows LinkedIn + Djinni unread combined.

**Architecture:** Two independent checkers each write their own atomic state file (`check.mjs`→`notify-state.json`, `djinni-check.mjs`→`djinni-notify-state.json`); the `Jobs.app` Swift daemon polls both and badges the sum. A separate browser profile (`.djinni-profile/`) holds the Djinni session. A new hourly LaunchAgent runs the Djinni checker.

**Tech Stack:** Node.js (ESM), Playwright (persistent context), Swift/Cocoa (Dock app), launchd.

**Spec:** `docs/superpowers/specs/2026-06-10-djinni-inbox-badge-design.md`

**Note on TDD:** The reusable atomic-state contract (`lib/notify-state.mjs`) is already unit-tested (`test/notify-state.test.mjs`) and is reused unchanged — no new unit test is added. The new code is a browser scraper and a Dock daemon whose correctness depends on the live DOM and the macOS Dock; these are verified by running them (HEADFUL browser run; visual badge check), not by unit tests. Verification steps below run the real thing and state the expected observable output.

**Branch:** `feature/djinni-inbox-badge` (already created, based off the PR #1 branch `feature/linkedin-message-badge`).

---

### Task 1: Djinni login script

Persists a Djinni browser session to `.djinni-profile/` so the scheduled checker can reuse it. Mirrors `login.mjs`.

**Files:**
- Create: `/Users/eugenelazeba/linkedin-assistant/djinni-login.mjs`

- [ ] **Step 1: Write `djinni-login.mjs`**

```javascript
// ONE-TIME (and whenever the session expires): opens a real browser window.
// YOU log in to Djinni manually — including 2FA. This script never sees or
// stores your password; it only persists the browser session (cookies) into
// ./.djinni-profile so the scheduled check can reuse it.
//
// It AUTO-DETECTS a successful login (no need to press anything), then saves
// and closes. Times out after ~6 minutes if you don't finish logging in.
//
// Run:  node djinni-login.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".djinni-profile");
const TIMEOUT_MS = 6 * 60 * 1000;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://djinni.co/login", { waitUntil: "domcontentloaded" });

console.log("\n========================================================");
console.log(" A browser window has opened.");
console.log(" Log in to Djinni there (handle 2FA if asked).");
console.log(" This will detect success automatically and close itself.");
console.log("========================================================\n");

// Indicators that we are logged in (any one is enough).
async function isLoggedIn() {
  // 1) A Djinni session cookie is present.
  try {
    const cookies = await ctx.cookies("https://djinni.co");
    if (cookies.some((c) => c.name === "sessionid" && c.value)) return true;
  } catch {}
  // 2) We have left the /login page for an authenticated path, OR an
  //    authenticated nav element (user menu / inbox link / logout) is visible.
  try {
    if (/djinni\.co\/my\//.test(page.url())) return true;
    const el = await page.$(
      "a[href*='/logout'], a[href*='/my/inbox'], .profile-dropdown, [class*='user-menu']"
    );
    if (el) return true;
  } catch {}
  return false;
}

const start = Date.now();
let ok = false;
while (Date.now() - start < TIMEOUT_MS) {
  if (await isLoggedIn()) { ok = true; break; }
  await page.waitForTimeout(3000);
}

if (ok) {
  console.log("✅ Login detected. Saving session to .djinni-profile ...");
  // Give the persistent context a moment to flush cookies to disk.
  await page.waitForTimeout(2000);
  await ctx.close();
  console.log("✅ Done. You can now run:  node djinni-check.mjs");
  process.exit(0);
} else {
  console.log("⌛ Timed out waiting for login. Nothing saved. Re-run: node djinni-login.mjs");
  await ctx.close();
  process.exit(1);
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check djinni-login.mjs`
Expected: no output, exit 0 (file parses).

- [ ] **Step 3: Manual login verification**

Run: `node djinni-login.mjs`
Expected: a browser window opens at the Djinni login page. After you log in, the
console prints `✅ Login detected. Saving session to .djinni-profile ...` then
`✅ Done.` and the window closes. A `.djinni-profile/` directory now exists.
Confirm: `test -d .djinni-profile && echo "profile saved"` prints `profile saved`.

- [ ] **Step 4: Commit**

```bash
git add djinni-login.mjs
git commit -m "feat: add Djinni login script (persists session to .djinni-profile)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Djinni inbox unread checker

Reuses the `.djinni-profile` session, counts unread inbox threads, writes
`djinni-notify-state.json`. Count-only: never opens threads, never drafts.
Modelled on `check.mjs` (logged-out detection, `ensureJobsApp`, `writeState`).

**Files:**
- Create: `/Users/eugenelazeba/linkedin-assistant/djinni-check.mjs`
- Reuse (no change): `lib/notify-state.mjs` (`writeState`)

- [ ] **Step 1: Write `djinni-check.mjs`**

```javascript
// The scheduled Djinni job. Reuses the session saved by djinni-login.mjs, reads
// the UNREAD count from https://djinni.co/my/inbox/, and writes it to
// djinni-notify-state.json. The Jobs.app Dock badge sums this with the LinkedIn
// count (notify-state.json). COUNT ONLY: it never opens a thread, never drafts,
// never sends — so it does not change Djinni's read state.
//
// Run:  node djinni-check.mjs              (headless)
//       HEADFUL=1 node djinni-check.mjs    (watch it work — useful for fixing selectors)

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeState } from "./lib/notify-state.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".djinni-profile");
const STATE_FILE = join(__dir, "djinni-notify-state.json");
const JOBS_APP = join(__dir, "Jobs.app"); // built by build-jobs.sh
const HEADFUL = process.env.HEADFUL === "1";

// ---- Selectors (centralized; verify against the live page with HEADFUL=1) ----
// Djinni is server-rendered and does not obfuscate class names, but markup can
// still change. Two strategies: (1) the nav's own unread counter, (2) per-row
// unread markers in the inbox list.
const SEL = {
  // (1) Primary: the unread-messages counter shown in the top nav / inbox link.
  navUnread:
    ".js-unread-messages, .unread-count, a[href*='/my/inbox'] .badge, " +
    "a[href*='/my/inbox'] [class*='count'], [class*='unread'][class*='count']",
  // (2) Fallback: conversation rows in the inbox list.
  inboxRow:
    "a[href*='/my/inbox/'], .inbox__item, li.conversation, [class*='conversation-item']",
  // An unread marker WITHIN a row (class-based).
  rowUnread:
    ".unread, .is-unread, [class*='unread'], .badge, .new",
};

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function notify(title, message) {
  // macOS notification; best-effort, never throws.
  execFile(
    "osascript",
    ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    () => {}
  );
}

// Keep the persistent Jobs.app badge daemon running so it can render the Dock
// badge. `--background` means "badge only, do not open the dashboard"; `-g`
// keeps focus on the user's current app. No-op if already running. Best-effort.
function ensureJobsApp() {
  if (!existsSync(JOBS_APP)) {
    log("notify: Jobs.app missing at", JOBS_APP, "— run ./build-jobs.sh");
    return;
  }
  try {
    const p = spawn("open", ["-g", "-a", JOBS_APP, "--args", "--background"],
      { detached: true, stdio: "ignore" });
    p.on("error", (e) => log("notify: ensureJobsApp failed:", e?.message));
    p.unref();
  } catch (e) { log("notify: ensureJobsApp threw:", e?.message); }
}

// Parse the first integer found in a string ("3", "(3)", "3 new" -> 3).
function firstInt(s) {
  const m = String(s || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !HEADFUL,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

let unreadCount = 0;

try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://djinni.co/my/inbox/", { waitUntil: "domcontentloaded", timeout: 30000 });

  // Detect a logged-out session early and bail with a clear message.
  if (/\/login|\/signup|\/auth/.test(page.url()) || (await page.$("input[type='password']"))) {
    log("❌ Not logged in (session expired). Run:  node djinni-login.mjs");
    notify("Djinni assistant", "Session expired — run `node djinni-login.mjs` to re-authenticate.");
    await ctx.close();
    process.exit(2);
  }

  await page.waitForTimeout(1500); // let client-side counters settle

  // Keep the Dock-badge daemon (Jobs.app) alive.
  ensureJobsApp();

  // (1) Primary: read Djinni's own unread counter from the nav.
  try {
    const el = await page.$(SEL.navUnread);
    if (el) {
      const n = firstInt((await el.innerText()).trim());
      if (Number.isFinite(n)) {
        unreadCount = n;
        log(`Unread (nav counter): ${unreadCount}`);
      }
    }
  } catch {}

  // (2) Fallback: count inbox rows that carry an unread marker.
  if (unreadCount === 0) {
    try {
      const rows = await page.$$(SEL.inboxRow);
      log(`Inbox rows found: ${rows.length}`);
      let n = 0;
      for (const row of rows) {
        let isUnread = false;
        try { isUnread = await row.$(SEL.rowUnread).then(Boolean); } catch {}
        if (!isUnread) {
          // Bold thread title also indicates unread on many list UIs.
          try {
            isUnread = await row.evaluate((el) => {
              const w = getComputedStyle(el).fontWeight;
              return parseInt(w, 10) >= 600 || w === "bold";
            });
          } catch {}
        }
        if (isUnread) n++;
      }
      unreadCount = n;
      log(`Unread (row markers): ${unreadCount}`);
    } catch (e) {
      log("⚠️  Could not read inbox rows — DOM may have changed. Run with HEADFUL=1 to inspect.", e?.message);
    }
  }
} catch (err) {
  log("ERROR:", err?.message || err);
} finally {
  try {
    writeState(STATE_FILE, { count: unreadCount });
  } catch (e) {
    log("notify: writeState failed:", e?.message);
  }
  await ctx.close();
}

log(`Done. Djinni unread: ${unreadCount} -> ${STATE_FILE}`);
process.exit(0);
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check djinni-check.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: HEADFUL selector verification (the one manual gate)**

Run: `HEADFUL=1 node djinni-check.mjs`
Expected: a browser opens to `https://djinni.co/my/inbox/`. The console logs
either `Unread (nav counter): N` or `Unread (row markers): N`, then
`Done. Djinni unread: N`. **Cross-check N against the unread count Djinni itself
shows in its UI.** If they disagree, open DevTools on the inbox, find the real
unread element/class, and update the matching entry in the `SEL` object — then
re-run this step until N matches. (This is expected: selectors are best-effort
until confirmed against the live page.)

- [ ] **Step 4: Confirm the state file was written**

Run: `cat djinni-notify-state.json`
Expected: JSON like `{"count":N,"pending":[],"updatedAt":"...Z"}` where N matches
Step 3.

- [ ] **Step 5: Commit**

```bash
git add djinni-check.mjs
git commit -m "feat: count unread Djinni inbox threads into djinni-notify-state.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Sum both state files in the Dock badge

Make `Jobs.app` badge the sum of the LinkedIn and Djinni unread counts.

**Files:**
- Modify: `/Users/eugenelazeba/linkedin-assistant/jobs-app.swift`
- Rebuild with: `/Users/eugenelazeba/linkedin-assistant/build-jobs.sh` (no change to the script)

- [ ] **Step 1: Update the header comment**

Replace this block near the top of `jobs-app.swift`:

```swift
//   - Polls notify-state.json every ~3s and shows the unread LinkedIn message
//     count as a red Dock badge (cleared when the count is 0).
```

with:

```swift
//   - Polls notify-state.json AND djinni-notify-state.json every ~3s and shows
//     the COMBINED unread count (LinkedIn messages + Djinni inbox) as a red Dock
//     badge (cleared when the total is 0).
```

- [ ] **Step 2: Add the Djinni state path**

After this line:

```swift
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
```

add:

```swift
let djinniStatePath = (projectDir as NSString).appendingPathComponent("djinni-notify-state.json")
```

- [ ] **Step 3: Replace `poll()` with a sum over both files**

Replace this method:

```swift
    func poll() {
        var count = 0
        if let data = FileManager.default.contents(atPath: statePath),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let n = (obj["count"] as? NSNumber)?.intValue {
            count = n
        }
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }
```

with:

```swift
    // Read the "count" field from one notify-state JSON file (missing/invalid -> 0).
    func unreadCount(at path: String) -> Int {
        guard let data = FileManager.default.contents(atPath: path),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let n = (obj["count"] as? NSNumber)?.intValue else { return 0 }
        return max(0, n)
    }

    func poll() {
        // Combined badge: unread LinkedIn message threads + unread Djinni inbox threads.
        let count = unreadCount(at: statePath) + unreadCount(at: djinniStatePath)
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }
```

- [ ] **Step 4: Rebuild the app**

Run: `./build-jobs.sh`
Expected: ends with `Done. Test:  open -a ".../Jobs.app" ...` and no compile
errors from `swiftc`.

- [ ] **Step 5: Verify the combined badge**

Run:
```bash
node -e 'import("./lib/notify-state.mjs").then(m=>{m.writeState("notify-state.json",{count:2});m.writeState("djinni-notify-state.json",{count:3});})'
open -g -a ./Jobs.app --args --background
```
Expected: within ~3 s the `Jobs.app` ("Вакансии") Dock icon shows a red badge of
**5** (2 + 3).

Then run:
```bash
node -e 'import("./lib/notify-state.mjs").then(m=>{m.writeState("notify-state.json",{count:0});m.writeState("djinni-notify-state.json",{count:0});})'
```
Expected: within ~3 s the badge disappears (sum 0 → no badge).

- [ ] **Step 6: Commit**

```bash
git add jobs-app.swift
git commit -m "feat: badge the sum of LinkedIn and Djinni unread counts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Scheduling templates, gitignore, and README

Add the hourly Djinni LaunchAgent + run wrapper templates, ignore the
machine-local Djinni artifacts, and document the flow.

**Files:**
- Create: `/Users/eugenelazeba/linkedin-assistant/run-djinni.sh.example`
- Create: `/Users/eugenelazeba/linkedin-assistant/com.example.djinni-inbox.plist.example`
- Modify: `/Users/eugenelazeba/linkedin-assistant/.gitignore`
- Modify: `/Users/eugenelazeba/linkedin-assistant/README.md`

- [ ] **Step 1: Write `run-djinni.sh.example`**

```bash
#!/bin/bash
# Wrapper for the scheduled Djinni inbox check (launchd/cron strip your PATH, so
# set it explicitly). Copy to run-djinni.sh and fill in your own values
# (run-djinni.sh is gitignored).
set -euo pipefail

# Point this at the node that has playwright installed (adjust the version).
export PATH="$HOME/.nvm/versions/node/<YOUR_NODE_VERSION>/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")"
STAMP="$(date +%Y%m%d_%H%M%S)"

node djinni-check.mjs >> "logs/djinni_${STAMP}.log" 2>&1
echo "log: logs/djinni_${STAMP}.log"
```

- [ ] **Step 2: Write `com.example.djinni-inbox.plist.example`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  launchd job: runs the Djinni inbox check once an hour, at the top of every
  hour. It writes djinni-notify-state.json; the always-running Jobs.app badge
  daemon (see com.example.jobs-badge.plist.example) sums it with the LinkedIn
  count. Copy to a machine-local file and adjust the paths first.
  Install:
    cp com.example.djinni-inbox.plist.example ~/Library/LaunchAgents/com.example.djinni-inbox.plist
    launchctl load ~/Library/LaunchAgents/com.example.djinni-inbox.plist
  Uninstall:
    launchctl unload ~/Library/LaunchAgents/com.example.djinni-inbox.plist
  Note: runs only while you are logged into macOS; if the Mac was asleep at the
  scheduled time, launchd runs it once on wake.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.djinni-inbox</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/example/linkedin-assistant/run-djinni.sh</string>
  </array>

  <!-- Runs every hour at minute 0 (00:00, 01:00, 02:00 ... 23:00). -->
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>0</integer></dict>

  <key>StandardOutPath</key>
  <string>/Users/example/linkedin-assistant/logs/djinni.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/example/linkedin-assistant/logs/djinni.err.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

- [ ] **Step 3: Add Djinni artifacts to `.gitignore`**

Add this block to `.gitignore` (after the existing `.browser-profile/` line is
fine; placement is not critical):

```gitignore
# Djinni browser session (contains your logged-in cookies — never commit)
.djinni-profile/

# Runtime Dock-badge state for Djinni (written by djinni-check.mjs, read by Jobs.app)
djinni-notify-state.json
djinni-notify-state.json.tmp

# Machine-specific Djinni run wrapper — use run-djinni.sh.example
run-djinni.sh
```

(The real LaunchAgent `com.eugene.djinni-inbox.plist` is already covered by the
existing `com.*.plist` ignore rule.)

- [ ] **Step 4: Verify the ignores work**

Run:
```bash
git check-ignore -v .djinni-profile djinni-notify-state.json run-djinni.sh com.eugene.djinni-inbox.plist
```
Expected: each of the four paths is reported as ignored (one line per path
naming the matching `.gitignore` rule).

- [ ] **Step 5: Document in `README.md`**

In `README.md`, locate the section describing the LinkedIn login/check/badge
flow (search for `node login.mjs` and the `notify-state.json` / Dock badge
description). Add an adjacent subsection:

```markdown
## Djinni inbox (combined Dock badge)

The Dock badge on `Jobs.app` ("Вакансии") shows the **combined** number of
unread message threads from **LinkedIn** and **Djinni**.

One-time login (whenever the Djinni session expires):

```bash
node djinni-login.mjs   # opens a browser; log in to Djinni manually (incl. 2FA)
```

Count unread Djinni inbox threads (writes `djinni-notify-state.json`):

```bash
node djinni-check.mjs              # headless
HEADFUL=1 node djinni-check.mjs    # watch it / fix selectors against the live page
```

`djinni-check.mjs` is **count-only**: it reads `https://djinni.co/my/inbox/`,
never opens threads, never drafts, never sends. `Jobs.app` polls both
`notify-state.json` (LinkedIn) and `djinni-notify-state.json` (Djinni) every ~3 s
and badges their sum.

Run it hourly via launchd:

```bash
cp run-djinni.sh.example run-djinni.sh                      # then edit PATH/version
cp com.example.djinni-inbox.plist.example \
   ~/Library/LaunchAgents/com.eugene.djinni-inbox.plist      # then edit the paths
launchctl load ~/Library/LaunchAgents/com.eugene.djinni-inbox.plist
```
```

- [ ] **Step 6: Make the example wrapper executable**

Run: `chmod +x run-djinni.sh.example`
Expected: no output; `ls -l run-djinni.sh.example` shows the `x` bit (matches
`run.sh.example`).

- [ ] **Step 7: Commit**

```bash
git add run-djinni.sh.example com.example.djinni-inbox.plist.example .gitignore README.md
git commit -m "feat: add hourly Djinni LaunchAgent template, gitignore, and docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (end-to-end)

- [ ] **Reusable state contract still green**

Run: `npm test`
Expected: the existing `notify-state` suite passes (5/5), confirming the contract
`djinni-check.mjs` writes against is intact.

- [ ] **Live combined badge**

With a real Djinni session saved (`node djinni-login.mjs` done) and at least one
unread Djinni thread:
1. `node check.mjs` (or use the last LinkedIn count) and `node djinni-check.mjs`.
2. Confirm `Jobs.app` badge = LinkedIn unread + Djinni unread.
3. Read all Djinni messages, re-run `node djinni-check.mjs`, confirm the badge
   drops by the Djinni amount.

- [ ] **LaunchAgent loads**

Run: `launchctl load ~/Library/LaunchAgents/com.eugene.djinni-inbox.plist`
(after copying + editing paths)
Expected: no error; `launchctl list | grep djinni-inbox` shows the job.
