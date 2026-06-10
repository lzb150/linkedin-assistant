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
