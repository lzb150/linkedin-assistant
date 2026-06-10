// The scheduled Djinni job. Reuses the session saved by djinni-login.mjs and
// counts UNREAD conversations using Djinni's own unread filter
// (/my/inbox?bucket=unread), then writes the count to djinni-notify-state.json.
// The Jobs.app Dock badge sums this with the LinkedIn count (notify-state.json).
// COUNT ONLY: it never opens a thread, never drafts, never sends — so it does
// not change Djinni's read state.
//
// Run:  node djinni-check.mjs              (headless)
//       HEADFUL=1 node djinni-check.mjs    (watch it work)

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

// Djinni's own "unread" inbox bucket. Counting the conversation threads listed
// here is the most reliable unread signal (verified against the live DOM):
// each thread is a link of the form /my/inbox/<id>/.
const UNREAD_URL = "https://djinni.co/my/inbox?bucket=unread";

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

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !HEADFUL,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

let unreadCount = 0;

try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(UNREAD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500); // let the conversation list render

  // Logged-out detection: Djinni redirects protected pages to /login, and the
  // /logout link is absent when not authenticated. (A `sessionid` cookie is set
  // even for anonymous visitors, so cookie presence is NOT a reliable signal.)
  const loggedIn = !/\/login/.test(page.url()) && (await page.$("a[href='/logout']").then(Boolean));
  if (!loggedIn) {
    // Intentionally do NOT writeState here (process.exit skips finally): leave
    // the last known count on the badge rather than zeroing it on a transient
    // session expiry.
    log("❌ Not logged in (session expired). Run:  node djinni-login.mjs");
    notify("Djinni assistant", "Session expired — run `node djinni-login.mjs` to re-authenticate.");
    await ctx.close();
    process.exit(2);
  }

  // Keep the Dock-badge daemon (Jobs.app) alive.
  ensureJobsApp();

  // Count distinct unread conversation threads. Each thread in the unread bucket
  // is one or more links of the form /my/inbox/<id>/...; dedupe by the numeric id.
  unreadCount = await page.evaluate(() => {
    const ids = new Set();
    for (const a of document.querySelectorAll("a[href*='/my/inbox/']")) {
      const m = (a.getAttribute("href") || "").match(/\/my\/inbox\/(\d+)\//);
      if (m) ids.add(m[1]);
    }
    return ids.size;
  });
  log(`Djinni unread threads: ${unreadCount}`);
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
