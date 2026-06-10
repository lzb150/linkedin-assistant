# Unread LinkedIn Message Badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a persistent red Dock badge with the count of unread LinkedIn message threads on the existing `Notifier.app`, while keeping its banner behaviour.

**Architecture:** `check.mjs` (sole writer) counts unread threads each scan and writes `notify-state.json`. The existing `Notifier.app` becomes a long-running, Dock-present app: a new daemon mode in `notifier.swift` polls that file every ~3 s, sets `NSApp.dockTile.badgeLabel` to the count, posts a banner for each new pending message, and opens LinkedIn on Dock-click. A LaunchAgent starts the app at login.

**Tech Stack:** Node.js (ESM `.mjs`, Playwright), Swift (Cocoa + UserNotifications), bash build script, launchd plist. Tests via `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-10-linkedin-message-badge-design.md`

---

## File Structure

- Create: `lib/notify-state.mjs` — atomic read/write of `notify-state.json` (sole-writer helper used by `check.mjs`).
- Create: `test/notify-state.test.mjs` — unit tests for the helper.
- Create: `com.eugene.notifier-badge.plist` — LaunchAgent to start `Notifier.app` at login.
- Create: `com.example.notifier-badge.plist.example` — sanitised template.
- Modify: `package.json` — add `"test": "node --test"` script.
- Modify: `notifier.swift` — add daemon mode (badge + pending banners + open-on-click); keep one-shot + `--status`.
- Modify: `build-notifier.sh` — remove `LSUIElement` so the app shows in the Dock.
- Modify: `check.mjs` — count unread threads, write state via the helper, ensure daemon running, drop per-message `open -n`.
- Modify: `.gitignore` — ignore runtime `notify-state.json`.
- Modify: `README.md` — document the Dock badge.

**State file shape** (`notify-state.json`):
```json
{ "count": 2, "pending": [ { "id": "thread-id", "sender": "Helen", "text": "hi" } ], "updatedAt": "2026-06-10T10:00:00.000Z" }
```
- `count` — total unread threads → Dock badge number.
- `pending` — new-message banners for the daemon to post; `id` dedupes.

---

## Task 1: State-file helper (`lib/notify-state.mjs`) — TDD

**Files:**
- Create: `lib/notify-state.mjs`
- Test: `test/notify-state.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the test script to `package.json`**

Edit the `"scripts"` block so it reads:
```json
  "scripts": {
    "login": "node login.mjs",
    "check": "node check.mjs",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/notify-state.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../lib/notify-state.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "ns-")); }

test("writeState then readState round-trips count and pending", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 2, pending: [{ id: "a", sender: "Helen", text: "hi" }] });
  const s = readState(p);
  assert.equal(s.count, 2);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].sender, "Helen");
  assert.ok(s.updatedAt);
  rmSync(dir, { recursive: true, force: true });
});

test("readState returns defaults for a missing file", () => {
  const s = readState("/no/such/notify-state.json");
  assert.deepEqual(s, { count: 0, pending: [], updatedAt: "" });
});

test("readState tolerates malformed JSON", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeFileSync(p, "{ not json");
  const s = readState(p);
  assert.equal(s.count, 0);
  assert.deepEqual(s.pending, []);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState clamps negative/fractional count to a non-negative integer", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: -3 });
  assert.equal(readState(p).count, 0);
  writeState(p, { count: 2.9 });
  assert.equal(readState(p).count, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState defaults pending to an empty array", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 0 });
  assert.deepEqual(readState(p).pending, []);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/notify-state.mjs'`.

- [ ] **Step 4: Implement the helper**

Create `lib/notify-state.mjs`:
```js
// Atomic read/write of the notifier state file shared between check.mjs (the
// SOLE writer) and the persistent Notifier.app daemon (the reader). The daemon
// polls this file to drive the Dock badge and to post new-message banners.
//
// Shape: { count: number, pending: [{ id, sender, text }], updatedAt: ISOString }
//   count   - total unread LinkedIn message threads -> Dock badge number
//   pending - new-message banners for the daemon to present (id dedupes)

import { writeFileSync, readFileSync, renameSync } from "node:fs";

export function readState(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      count: Number.isFinite(raw.count) ? Math.max(0, Math.trunc(raw.count)) : 0,
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  } catch {
    return { count: 0, pending: [], updatedAt: "" };
  }
}

export function writeState(path, { count = 0, pending = [] } = {}) {
  const state = {
    count: Math.max(0, Math.trunc(count) || 0),
    pending: Array.isArray(pending) ? pending : [],
    updatedAt: new Date().toISOString(),
  };
  // Atomic: write a sibling temp file, then rename over the target so a
  // concurrent reader (the daemon) never sees a half-written file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 0));
  renameSync(tmp, path);
  return state;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add lib/notify-state.mjs test/notify-state.test.mjs package.json
git commit -m "feat: add atomic notify-state helper for Dock badge"
```

---

## Task 2: Remove `LSUIElement` so the app shows in the Dock

**Files:**
- Modify: `build-notifier.sh`

- [ ] **Step 1: Drop the `LSUIElement` key from the generated Info.plist**

In `build-notifier.sh`, inside the `Info.plist` heredoc, delete this line:
```xml
  <key>LSUIElement</key><true/>
```
Leave every other key unchanged (same `CFBundleIdentifier`, same signing — so the granted notification permission is preserved).

- [ ] **Step 2: Update the heredoc comment above the icon section (optional clarity)**

No functional change required beyond Step 1. The icon build, signing, and `lsregister` blocks stay as-is.

- [ ] **Step 3: Commit**

```bash
git add build-notifier.sh
git commit -m "feat: make Notifier.app a Dock app (drop LSUIElement)"
```

> Note: do NOT rebuild yet — Task 3 changes `notifier.swift`; rebuild once in Task 4.

---

## Task 3: Add daemon mode to `notifier.swift`

**Files:**
- Modify: `notifier.swift` (full rewrite — keeps `--status` and one-shot banner; adds daemon)

- [ ] **Step 1: Replace `notifier.swift` with the three-mode version**

Overwrite `notifier.swift` with:
```swift
// macOS notification helper + Dock badge daemon for linkedin-assistant.
//
// Modes (selected by argv):
//   notifier                 -> DAEMON: stays in the Dock (green Messages icon),
//                               reads notify-state.json every ~3s, sets the red
//                               Dock badge to the unread count, posts a banner
//                               for each new pending message, and opens LinkedIn
//                               messaging on Dock-click.
//   notifier "title" "body"  -> one-shot banner (used by build-notifier.sh test).
//   notifier --status        -> print authorization status and exit.
//
// Banners use UserNotifications so they render under THIS bundle's green
// "Messages" icon. Silent by design (no sound).

import Cocoa
import UserNotifications

let args = CommandLine.arguments
let DEBUG = ProcessInfo.processInfo.environment["NOTIFIER_DEBUG"] != nil

func dbg(_ s: String) {
    guard DEBUG else { return }
    FileHandle.standardError.write(("notifier: " + s + "\n").data(using: .utf8)!)
}

// ---- notifier --status : read-only; never call requestAuthorization here -----
if args.count > 1 && args[1] == "--status" {
    let sema = DispatchSemaphore(value: 0)
    UNUserNotificationCenter.current().getNotificationSettings { s in
        print("authorizationStatus=\(s.authorizationStatus.rawValue) alertSetting=\(s.alertSetting.rawValue)")
        sema.signal()
    }
    _ = sema.wait(timeout: .now() + 3)
    exit(0)
}

// ---- One-shot banner: `notifier "title" "body"` (kept for manual testing) ----
if args.count >= 3 {
    let title = args[1]
    let body = args[2]
    final class OneShot: NSObject, UNUserNotificationCenterDelegate {
        let center = UNUserNotificationCenter.current()
        var done = false
        let title: String, body: String
        init(title: String, body: String) { self.title = title; self.body = body }
        func run() {
            center.delegate = self
            center.requestAuthorization(options: [.alert]) { granted, error in
                dbg("requestAuthorization granted=\(granted) error=\(String(describing: error))")
                let content = UNMutableNotificationContent()
                content.title = self.title
                content.body = self.body
                let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
                self.center.add(req) { _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.done = true }
                }
            }
        }
        func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                    withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
            h([.banner, .list])
        }
    }
    let one = OneShot(title: title, body: body)
    one.run()
    let deadline = Date().addingTimeInterval(8)
    while !one.done && Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    exit(0)
}

// ---- Daemon: `notifier` (no args). Persistent Dock app + badge. -------------

// notify-state.json lives next to the .app bundle, in the project directory.
let bundlePath = Bundle.main.bundlePath                       // <project>/Notifier.app
let projectDir = (bundlePath as NSString).deletingLastPathComponent
let statePath = (projectDir as NSString).appendingPathComponent("notify-state.json")
let messagingURL = URL(string: "https://www.linkedin.com/messaging/")!

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var delivered = Set<String>()
    var seeded = false
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)            // show in Dock, own a dock tile
        center.delegate = self
        center.requestAuthorization(options: [.alert]) { granted, error in
            dbg("daemon auth granted=\(granted) error=\(String(describing: error))")
        }
        dbg("daemon started; state=\(statePath)")
        poll()                                          // immediate first pass
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in self?.poll() }
    }

    // Dock-icon click -> open LinkedIn messaging.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        NSWorkspace.shared.open(messagingURL)
        return true
    }

    func poll() {
        guard let data = FileManager.default.contents(atPath: statePath) else {
            setBadge(0); return
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return                                       // partial/garbled; retry next tick
        }
        let count = (obj["count"] as? NSNumber)?.intValue ?? 0
        setBadge(count)

        let pending = (obj["pending"] as? [[String: Any]]) ?? []
        // First poll after launch: seed `delivered` with whatever is already in
        // the file so a daemon restart does not replay old banners.
        if !seeded {
            for p in pending { if let id = p["id"] as? String { delivered.insert(id) } }
            seeded = true
            return
        }
        for p in pending {
            guard let id = p["id"] as? String, !delivered.contains(id) else { continue }
            delivered.insert(id)
            let sender = (p["sender"] as? String) ?? "LinkedIn"
            let text = (p["text"] as? String) ?? "New message"
            postBanner(title: sender, body: text)
        }
    }

    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }

    func postBanner(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(req) { err in dbg("banner add err=\(String(describing: err))") }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .list])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
```

- [ ] **Step 2: Commit**

```bash
git add notifier.swift
git commit -m "feat: add daemon mode (Dock badge + pending banners) to notifier"
```

---

## Task 4: Rebuild and manually verify the badge

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the app**

Run: `./build-notifier.sh`
Expected: `Building .../Notifier.app …`, `icon: built multi-size AppIcon.icns …`, `registered with LaunchServices`, `Done.`

- [ ] **Step 2: Verify the one-shot banner still works (back-compat)**

Run: `open -n -a ./Notifier.app --args "Helen Rozen" "hello from LinkedIn"`
Expected: a banner appears under the green Messages icon. (If first run, click Allow.)

- [ ] **Step 3: Write a test state file with a count and start the daemon**

Run:
```bash
printf '%s' '{"count":3,"pending":[],"updatedAt":"now"}' > notify-state.json
open -g -a ./Notifier.app
```
Expected: within ~3 s the `Notifier.app` Dock icon shows a red **3** badge. (`-g` keeps focus on your current app.)

- [ ] **Step 4: Verify the badge follows the count down to zero**

Run:
```bash
printf '%s' '{"count":1,"pending":[],"updatedAt":"now"}' > notify-state.json
sleep 4
printf '%s' '{"count":0,"pending":[],"updatedAt":"now"}' > notify-state.json
```
Expected: badge shows **1**, then disappears when count is 0.

- [ ] **Step 5: Verify a pending banner fires once**

Run:
```bash
printf '%s' '{"count":1,"pending":[{"id":"t1","sender":"Recruiter","text":"New role for you"}],"updatedAt":"now"}' > notify-state.json
```
Expected: one banner ("Recruiter" / "New role for you") appears and the badge shows **1**. Re-saving the same file (same `id`) must NOT re-fire the banner.

- [ ] **Step 6: Verify Dock-click opens LinkedIn**

Click the `Notifier.app` Dock icon.
Expected: the default browser opens `https://www.linkedin.com/messaging/`.

- [ ] **Step 7: Clean up the scratch state file and quit the test instance**

Run:
```bash
rm -f notify-state.json
osascript -e 'tell application "Notifier" to quit' 2>/dev/null || true
```
Expected: scratch file removed; daemon quits. (No commit — verification only.)

---

## Task 5: Wire `check.mjs` to count unread and write state

**Files:**
- Modify: `check.mjs`

- [ ] **Step 1: Import the helper and define the state path**

Near the other imports (after line `import { buildDraft } from "./lib/draft.mjs";`), add:
```js
import { writeState } from "./lib/notify-state.mjs";
```
Near the other path constants (after `const SEEN_FILE = join(__dir, "seen.json");`), add:
```js
const STATE_FILE = join(__dir, "notify-state.json");
```

- [ ] **Step 2: Replace the per-message notifier with a daemon-ensure + state model**

Delete the entire `notifyMessage(...)` function (the block starting `// iPhone-style "new message" banner:` through the closing `}` of `function notifyMessage`). Keep the small `notify(...)` osascript helper — it is still used for the session-expired alert.

Immediately after the `notify(...)` helper, add:
```js
// Ensure the persistent Notifier.app daemon is running so it can render the
// Dock badge and banners from notify-state.json. `-g` keeps focus on the user's
// current app; `open` is a no-op if the daemon is already running.
function ensureDaemon() {
  if (!existsSync(NOTIFIER_APP)) {
    log("notify: Notifier.app missing at", NOTIFIER_APP, "— run ./build-notifier.sh");
    return;
  }
  try {
    const p = spawn("open", ["-g", "-a", NOTIFIER_APP], { detached: true, stdio: "ignore" });
    p.on("error", (e) => log("notify: ensureDaemon failed:", e?.message));
    p.unref();
  } catch (e) { log("notify: ensureDaemon threw:", e?.message); }
}
```

- [ ] **Step 3: Declare the badge/pending accumulators in outer scope**

Find `let drafted = 0;` and `let scanned = 0;` (just before `try {`). Add directly below them:
```js
let unreadCount = 0;
const pending = [];
```

- [ ] **Step 4: Ensure the daemon is up, then count unread threads**

Inside the `try {` block, right after `log(`Found ${cards.length} conversation cards.`);`, add:
```js
  // Keep the Dock-badge daemon alive, then count ALL unread threads (independent
  // of MAX and the job-relevance filter) — this drives the badge number.
  ensureDaemon();
  for (const card of cards) {
    if (await cardIsUnread(card)) unreadCount++;
  }
  log(`Unread threads: ${unreadCount}`);
```

- [ ] **Step 5: Queue a banner instead of firing one per message**

Find the line:
```js
    notifyMessage(name, snippet);
```
Replace it with:
```js
    pending.push({
      id: threadId,
      sender: name,
      text: (snippet || "").replace(/\s+/g, " ").trim().slice(0, 240) || "New message",
    });
```

- [ ] **Step 6: Write the state file in `finally`**

In the `finally {` block, after `saveSeen(seen);`, add:
```js
  try {
    writeState(STATE_FILE, { count: unreadCount, pending });
  } catch (e) {
    log("notify: writeState failed:", e?.message);
  }
```

- [ ] **Step 7: Syntax-check the module**

Run: `node --check check.mjs`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add check.mjs
git commit -m "feat: write notify-state.json (unread count + banners) from check"
```

---

## Task 6: Autostart the daemon at login (LaunchAgent)

**Files:**
- Create: `com.eugene.notifier-badge.plist`
- Create: `com.example.notifier-badge.plist.example`

- [ ] **Step 1: Create the real LaunchAgent plist**

Create `com.eugene.notifier-badge.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  launchd job: starts the persistent Notifier.app (Dock badge + banners) at login.
  Install:
    cp com.eugene.notifier-badge.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.eugene.notifier-badge.plist
  Uninstall:
    launchctl unload ~/Library/LaunchAgents/com.eugene.notifier-badge.plist
  The app is also re-launched defensively by check.mjs (open -g) on each scan.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.eugene.notifier-badge</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-a</string>
    <string>/Users/eugenelazeba/linkedin-assistant/Notifier.app</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/eugenelazeba/linkedin-assistant/logs/notifier-badge.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/eugenelazeba/linkedin-assistant/logs/notifier-badge.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create the sanitised example**

Create `com.example.notifier-badge.plist.example` — identical to Step 1 but with `com.eugene` → `com.example` in `Label` and the three `/Users/eugenelazeba/linkedin-assistant/...` paths → `/Users/example/linkedin-assistant/...`.

- [ ] **Step 3: Install and load the agent**

Run:
```bash
cp com.eugene.notifier-badge.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.eugene.notifier-badge.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.eugene.notifier-badge.plist
```
Expected: no error. The `Notifier.app` icon appears in the Dock (no badge while `notify-state.json` is absent or count 0).

- [ ] **Step 4: Commit**

```bash
git add com.eugene.notifier-badge.plist com.example.notifier-badge.plist.example
git commit -m "feat: add LaunchAgent to start Notifier.app at login"
```

---

## Task 7: Ignore runtime state + document the badge

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Ignore the runtime state file**

Append to `.gitignore`:
```gitignore

# Runtime Dock-badge / banner state (written by check.mjs, read by Notifier.app)
notify-state.json
notify-state.json.tmp
```

- [ ] **Step 2: Document the badge in `README.md`**

Add this section to `README.md` (place it near the existing notifications/Notifier description):
```markdown
### Dock badge for unread messages

`Notifier.app` runs persistently in the Dock with the green Messages icon. On
each scan, `check.mjs` writes `notify-state.json` with the number of unread
LinkedIn message threads; the app reads it every few seconds and shows that
number as a red Dock badge. The badge clears once the threads are read on
LinkedIn (the next scan reports a lower count). Click the Dock icon to open
LinkedIn messaging.

Build the app with `./build-notifier.sh`, then start it at login by installing
`com.eugene.notifier-badge.plist` into `~/Library/LaunchAgents/`.
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore README.md
git commit -m "docs: ignore notify-state.json and document the Dock badge"
```

---

## Task 8: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run a real scan**

Run: `node check.mjs`
Expected: log lines include `Unread threads: N`; on success `notify-state.json` exists with `{"count":N,...}`.

- [ ] **Step 2: Confirm the badge reflects the real count**

Inspect: the `Notifier.app` Dock icon shows the badge **N** matching the log (or no badge when N is 0). New unread threads also produce a banner.

- [ ] **Step 3: Confirm read-state clears the badge**

Open the unread thread(s) in LinkedIn in your browser, then re-run `node check.mjs`.
Expected: `Unread threads:` drops; the Dock badge decreases/clears accordingly.

- [ ] **Step 4: Confirm the full test suite still passes**

Run: `npm test`
Expected: PASS (Task 1 tests green).

---

## Known limitations (documented, out of scope)

- `check.mjs` opens unread threads to read them, which may mark them read on LinkedIn; the count is taken at scan start, so over successive scans the badge tracks LinkedIn's own read-state and may decline after the assistant has processed a thread. This matches the "count = LinkedIn's unread" decision and is acceptable.
- If the daemon is restarted while `notify-state.json` holds undelivered `pending` entries, those banners are suppressed (seeded as already-delivered) to avoid replay; the badge count remains correct.
