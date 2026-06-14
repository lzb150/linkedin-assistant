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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeState } from "./lib/notify-state.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".djinni-profile");
const STATE_FILE = join(__dir, "djinni-notify-state.json");
// Thread ids we have already posted a banner for. Persisted across runs so a
// given unread conversation only notifies once. A network error never touches
// this file, so a transient blip can't trigger a spurious re-notification.
const SEEN_FILE = join(__dir, "djinni-seen.json");
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
// keeps focus on the user's current app.
// Guard: skip open(1) if Jobs.app is already running — calling open(1) on a
// running app triggers applicationShouldHandleReopen, which opens the dashboard.
function ensureJobsApp() {
  if (!existsSync(JOBS_APP)) {
    log("notify: Jobs.app missing at", JOBS_APP, "— run ./build-jobs.sh");
    return;
  }
  if (spawnSync("pgrep", ["-x", "Jobs"], { stdio: "ignore" }).status === 0) return;
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
  args: [
    "--disable-blink-features=AutomationControlled",
    ...(HEADFUL ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
  ],
});

let unreadCount = 0;
let scanned = false; // true once we have a real count from a loaded page
let unreadThreads = []; // [{ id, label }] persisted so Jobs.app can open them

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

  // Collect distinct unread conversation threads. Each thread in the unread
  // bucket is one or more links of the form /my/inbox/<id>/...; dedupe by the
  // numeric id and keep the first non-empty link label (recruiter/company name).
  const threads = await page.evaluate(() => {
    const byId = new Map();
    for (const a of document.querySelectorAll("a[href*='/my/inbox/']")) {
      const m = (a.getAttribute("href") || "").match(/\/my\/inbox\/(\d+)\//);
      if (!m) continue;
      const id = m[1];
      const label = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!byId.has(id) || (!byId.get(id) && label)) byId.set(id, label);
    }
    return [...byId.entries()].map(([id, label]) => ({ id, label }));
  });
  unreadCount = threads.length;
  unreadThreads = threads;
  scanned = true;
  log(`Djinni unread threads: ${unreadCount}`);

  // Banner only for threads we have not already notified about. The seen set is
  // the unread ids from the previous successful scan; a thread that is read (and
  // leaves the unread bucket) drops out, so if it ever goes unread again it will
  // notify afresh. First run with no seen file notifies for current unread.
  let seen = [];
  try {
    if (existsSync(SEEN_FILE)) {
      const raw = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
      if (Array.isArray(raw)) seen = raw.map(String);
    }
  } catch (e) { log("notify: reading seen file failed:", e?.message); }

  const seenSet = new Set(seen);
  const fresh = threads.filter((t) => !seenSet.has(t.id));
  if (fresh.length) {
    const first = fresh.find((t) => t.label)?.label;
    const message =
      fresh.length === 1
        ? `New message${first ? `: ${first}` : ""}`
        : `${fresh.length} new messages${first ? ` (incl. ${first})` : ""}`;
    notify("Djinni", message);
    log(`notify: banner for ${fresh.length} new thread(s)`);
  }

  try {
    writeFileSync(SEEN_FILE, JSON.stringify(threads.map((t) => t.id)));
  } catch (e) { log("notify: writing seen file failed:", e?.message); }
} catch (err) {
  log("ERROR:", err?.message || err);
} finally {
  // Only overwrite the badge when we actually loaded the page. On a network
  // error (page never loaded) leave the last known count so the badge does not
  // flicker to 0 — same policy as the session-expiry path above.
  if (scanned) {
    try {
      // Persist the unread threads (id + label) too, so Jobs.app can open the
      // conversation on a Dock click: a single unread opens that thread, several
      // open the unread bucket.
      writeState(STATE_FILE, {
        count: unreadCount,
        pending: unreadThreads.map((t) => ({ id: t.id, label: t.label })),
      });
    } catch (e) {
      log("notify: writeState failed:", e?.message);
    }
  } else {
    log("scan failed — keeping last known badge count (state not rewritten)");
  }
  await ctx.close();
}

log(
  scanned
    ? `Done. Djinni unread: ${unreadCount} -> ${STATE_FILE}`
    : `Done. Scan failed; badge left unchanged.`,
);
process.exit(0);
