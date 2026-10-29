// The scheduled Djinni job. Reuses the session saved by `node login.mjs djinni` and
// counts UNREAD conversations using Djinni's own unread filter
// (/my/inbox?bucket=unread), then writes the count to djinni-notify-state.json.
// The Jobs.app Dock badge sums this with the LinkedIn count (notify-state.json).
// COUNT ONLY: it never opens a thread, never drafts, never sends — so it does
// not change Djinni's read state.
//
// Run:  node djinni-check.mjs              (headless)
//       HEADFUL=1 node djinni-check.mjs    (watch it work)

import { runScan, sessionExpired, LOGGED_OUT } from "./lib/scan-run.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { updateState } from "./lib/notify-state.mjs";
import { writeJsonAtomic, readJson } from "./lib/json-file.mjs";
import { log, notify, ensureJobsApp } from "./lib/notify.mjs";
import { heartbeat } from "./lib/heartbeat.mjs";
import { readBumpState, dueForCheck, nextBumpState, bumpProfile, djinniLoggedIn, freshThreads } from "./lib/djinni-bump.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".djinni-profile");
const STATE_FILE = join(__dir, "djinni-notify-state.json");
const HEARTBEAT_FILE = join(__dir, "last-success.json");
// Thread ids we have already posted a banner for. Persisted across runs so a
// given unread conversation only notifies once. A network error never touches
// this file, so a transient blip can't trigger a spurious re-notification.
const SEEN_FILE = join(__dir, "djinni-seen.json");
// "Bump My Profile" throttle state (see lib/djinni-bump.mjs).
const BUMP_STATE_FILE = join(__dir, "djinni-bump-state.json");

// Djinni's own "unread" inbox bucket. Counting the conversation threads listed
// here is the most reliable unread signal (verified against the live DOM):
// each thread is a link of the form /my/inbox/<id>/.
const UNREAD_URL = "https://djinni.co/my/inbox?bucket=unread";

let scanned = false; // true once we have a real count from a loaded page
let unreadThreads = []; // [{ id, label }] persisted so Jobs.app can open them

const outcome = await runScan({ profile: PROFILE, app: "Djinni assistant", scan, finish });

async function scan(page) {
  if (await openUnread(page) === LOGGED_OUT) return LOGGED_OUT;
  // Keep the Dock-badge daemon (Jobs.app) alive.
  ensureJobsApp();
  const { threads, bucketEmpty } = await listUnread(page);
  unreadThreads = threads;
  // An unexplained empty list (selector drift, or a list still rendering) is not
  // a count: zeroing the badge on it hid a real unread thread for an hour. Same
  // rule as the seen-store write in bannerFresh and check.mjs's drift verdict.
  scanned = threads.length > 0 || bucketEmpty;
  log(`Djinni unread threads: ${threads.length}`);
  if (!scanned) log("⚠️  Empty list without .threads-empty — selector may have drifted; badge left unchanged.");
  bannerFresh(threads, bucketEmpty);
  await bumpIfDue(page);
}

async function openUnread(page) {
  await page.goto(UNREAD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Wait for the list or Djinni's empty-state block, not a fixed 1.5 s: a list
  // that rendered later read as an unexplained zero (and, in scan, no badge write).
  await page.waitForSelector("a[href*='/my/inbox/'], .threads-empty", { timeout: 10000 }).catch(() => {});

  // Logged out: `scanned` stays false, so finish() leaves the badge's last
  // known count alone, and runScan exits 2 after the bounded close.
  if (!(await djinniLoggedIn(page))) return sessionExpired("Djinni assistant", "node login.mjs djinni");
}

async function listUnread(page) {
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
  // Djinni's own empty-state block (verified live 2026-09-29: `.threads-empty`,
  // with an illustration and "Nothing found"). A class, not the text: the UI
  // also ships in Ukrainian. Tells a truly empty bucket from a selector drift.
  const bucketEmpty = !threads.length && (await page.$(".threads-empty").then(Boolean));
  return { threads, bucketEmpty };
}

// Banner only for threads we have not already notified about (see freshThreads).
function bannerFresh(threads, bucketEmpty) {
  // A corrupt seen file reads as "nothing known", which re-banners every open
  // thread once. That is noisy but harmless, and the write below replaces the
  // file anyway — so recover, but do not do it silently.
  let seenIds = [];
  try { seenIds = readJson(SEEN_FILE, []); }
  catch (e) { log(`⚠ ${SEEN_FILE} unreadable (${e.message}) — treating every current thread as new for this run`); }
  const { fresh, message } = freshThreads(threads, seenIds);

  // Persist BEFORE the banner, not after: the two used to be the other way
  // round, so a crash or a kill in between left the ids unrecorded and the next
  // run bannered the same threads a second time.
  // Never rewrite the seen store from an UNEXPLAINED empty result. A selector
  // drift reads as an honest zero here, and truncating the file to [] means
  // every existing conversation banners again the moment the selector is
  // repaired. Only Djinni's own empty-state block makes zero trustworthy — and
  // it must clear the store: a read thread that stays in it never banners
  // again when the recruiter replies (freshThreads finds it "already known").
  if (threads.length || bucketEmpty) {
    try {
      writeJsonAtomic(SEEN_FILE, threads.map((t) => t.id));
    } catch (e) { log("notify: writing seen file failed:", e?.message); }
  }

  if (fresh.length) {
    // The phone copy opens the one new thread, or the unread list for several.
    notify("Djinni", message, { link: fresh.length === 1 ? `https://djinni.co/my/inbox/${fresh[0].id}/` : UNREAD_URL });
    log(`notify: banner for ${fresh.length} new thread(s)`);
  }
}

// Profile bump: Djinni allows one per 7 days (button state is the truth). One
// /my/profile/ visit a day, hourly around the expected cooldown end
// (state-throttled); a bump failure never breaks the unread scan above.
async function bumpIfDue(page) {
  try {
    const bumpState = readBumpState(BUMP_STATE_FILE);
    if (dueForCheck(bumpState)) {
      const outcome = await bumpProfile(page);
      writeJsonAtomic(BUMP_STATE_FILE, nextBumpState(bumpState, outcome));
      log(`bump: ${outcome}`);
      if (outcome === "bumped") notify("Djinni", "Profile bumped — back to the top of search results.");
      if (outcome === "unverified") notify("Djinni assistant", "Bump attempt could not be verified — check djinni.co/my/profile/ manually.");
    }
  } catch (e) { log("bump failed:", e?.message); }
}

function finish() {
  // Only overwrite the badge when we actually loaded the page. On a network
  // error (page never loaded) leave the last known count so the badge does not
  // flicker to 0 — same policy as the session-expiry path above.
  if (!scanned) { log("scan failed — keeping last known badge count (state not rewritten)"); return; }
  try {
    // Persist the unread threads (id + label) too, so Jobs.app can open the
    // conversation on a Dock click: a single unread opens that thread, several
    // open the unread bucket. Under `<path>.lock/` — the lock Jobs.app
    // clearBadge takes for its own rewrite of this file — so a Dock click and
    // this write never interleave; the previous state is not consulted.
    updateState(STATE_FILE, () => ({
      count: unreadThreads.length,
      pending: unreadThreads,
    }));
  } catch (e) {
    log("notify: writeState failed:", e?.message);
  }
}

if (outcome === "busy") log("Skipped (profile busy) — badge left unchanged.");
else log(
  scanned
    ? `Done. Djinni unread: ${unreadThreads.length} -> ${STATE_FILE}`
    : `Scan failed; badge left unchanged.`,
);
if (outcome === "ok" && scanned) heartbeat(HEARTBEAT_FILE, "djinni-check", { log, alert: (m) => notify("Job assistant", m) });
// launchd must see a failed run as failed; a busy profile is a benign overlap; logged out = 2, like check.mjs.
process.exit(outcome === "failed" ? 1 : outcome === LOGGED_OUT ? 2 : 0);
