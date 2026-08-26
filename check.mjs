// The scheduled job. Reuses the session saved by login.mjs, reads UNREAD message
// threads, scores each against your resume profile, and writes a draft reply for
// any relevant one. IT NEVER SENDS ANYTHING and never clicks "Send".
//
// Run:  node check.mjs              (headless; UNREAD threads only)
//       HEADFUL=1 node check.mjs    (watch it work — useful for fixing selectors)
//       MAX=10 node check.mjs       (cap how many threads to open)
//       SCAN_ALL=1 node check.mjs   (scan recent threads regardless of read state;
//                                     useful for a first pass / when unread marker is missed.
//                                     seen.json still prevents duplicate drafts.)

import { launchBrowser } from "./lib/browser.mjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage, looksLikeJobMessage } from "./lib/relevance.mjs";
import { buildDraft } from "./lib/draft.mjs";
import { writeState } from "./lib/notify-state.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { log, notify, ensureJobsApp } from "./lib/notify.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const DRAFTS = join(__dir, "drafts");
const SEEN_FILE = join(__dir, "seen.json");
const STATE_FILE = join(__dir, "notify-state.json");
// Digits-only guard: a garbage MAX would parse to NaN and every `>= MAX`
// comparison would be false, silently disabling the cap.
const MAX = /^\d+$/.test(process.env.MAX || "") ? Number(process.env.MAX) : 12;
const SCAN_ALL = process.env.SCAN_ALL === "1";

// ---- Selectors (centralized; LinkedIn obfuscates + changes these) ------------
const SEL = {
  conversationList: ".msg-conversations-container__conversations-list",
  // Only the real <li> rows (avoids the duplicate inner .pillar cards).
  conversationCard: "li.msg-conversation-listitem",
  // Multiple unread strategies; checked within each card (so the nav badge can't leak in).
  unreadHint: ".msg-conversation-card--unread, .notification-badge--show, .msg-conversation-card__unread-count, [class*='unread-indicator'], [class*='unread']",
  participantName: ".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names, [class*='participant-names']",
  messageBubble: ".msg-s-event-listitem__body, .msg-s-message-group__content",
  threadTitle: "#thread-detail-jump-target, .msg-thread__title, h2",
};

// Unread detection: class/badge markers OR a bold participant name (LinkedIn bolds unread).
async function cardIsUnread(card) {
  try {
    if (await card.$(SEL.unreadHint).then(Boolean)) return true;
  } catch {}
  try {
    return await card.evaluate((el) => {
      const n = el.querySelector("[class*='participant-names']");
      if (!n) return false;
      const w = getComputedStyle(n).fontWeight;
      return parseInt(w, 10) >= 600 || w === "bold";
    });
  } catch {}
  return false;
}

// Thread ids already processed; entries expire after 90 days so the file
// stops growing forever (legacy array files migrate on load).
const seen = loadSeenStore(SEEN_FILE);

let ctx;
let drafted = 0;
let scanned = 0;
let unreadCount = 0;
// Only overwrite the badge state when the scan actually counted the inbox —
// a navigation failure would otherwise reset the badge to 0 and hide unread
// messages until the next successful run.
let counted = false;

try {
  ctx = await launchBrowser(PROFILE); // inside try: a launch/lock failure logs + notifies instead of an unhandled rejection
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });

  // Detect a logged-out session early and bail with a clear message.
  if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
    log("❌ Not logged in (session expired). Run:  node login.mjs");
    notify("LinkedIn assistant", "Session expired — run `node login.mjs` to re-authenticate.");
    await ctx.close();
    process.exit(2);
  }

  await page.waitForSelector(SEL.conversationList, { timeout: 20000 }).catch(() => {
    log("⚠️  Conversation list selector not found — LinkedIn DOM may have changed. Run with HEADFUL=1 to inspect.");
  });

  // Collect candidate conversation cards.
  const cards = await page.$$(SEL.conversationCard);
  log(`Found ${cards.length} conversation cards.`);

  // Keep the Dock-badge daemon (Jobs.app) alive, then count ALL unread threads
  // (independent of MAX and the job-relevance filter) — this drives the badge.
  ensureJobsApp();
  // Computed once per card; reused by the scan loop below.
  const unread = [];
  for (const card of cards) unread.push(await cardIsUnread(card));
  unreadCount = unread.filter(Boolean).length;
  log(`Unread threads: ${unreadCount}`);
  counted = true;

  let lastOpened = null;
  for (const [i, card] of cards.entries()) {
    // MAX caps opened threads; drafted threads are already counted in scanned.
    if (scanned >= MAX) break;

    // Is it unread? (best-effort, multi-strategy). SCAN_ALL bypasses this filter.
    if (!SCAN_ALL && !unread[i]) continue;

    scanned++;
    let name = "Recruiter";
    try {
      const nameEl = await card.$(SEL.participantName);
      if (nameEl) name = (await nameEl.innerText()).trim().split("\n")[0] || name;
    } catch {}

    // Open the thread. If the URL still points at the PREVIOUS opened thread the
    // click failed — skip rather than misattribute that thread to this card.
    // (LinkedIn auto-opens the first thread, so only compare against our own.)
    await card.click().catch(() => {});
    await page.waitForTimeout(1500);
    const url = page.url();
    if (url === lastOpened) { log(`· could not open thread, skipping: ${name}`); continue; }
    lastOpened = url;

    // Stable-ish id from thread url; fallback includes the card index so two
    // same-named recruiters do not collide.
    const idMatch = url.match(/thread\/([^/]+)/);
    const threadId = idMatch ? idMatch[1] : `name:${name}:${i}`;

    // Read the message bubbles (most recent incoming text).
    let bubbles = [];
    try {
      const els = await page.$$(SEL.messageBubble);
      for (const el of els.slice(-12)) {
        const t = (await el.innerText()).trim();
        if (t) bubbles.push(t);
      }
    } catch {}
    const fullText = bubbles.join("\n");
    const snippet = bubbles.slice(-1)[0] || "";

    if (seen.has(threadId)) { log(`· already processed: ${name}`); continue; }

    if (!fullText || !looksLikeJobMessage(fullText)) {
      log(`· not a job message, skipping: ${name}`);
      seen.add(threadId);
      continue;
    }

    const scored = scoreMessage(fullText);
    log(`· ${name}: score=${scored.score} verdict=${scored.verdict} [${scored.matchedSkills.join(",")}]`);

    if (scored.verdict === "ignore") { seen.add(threadId); continue; }

    const { filename, markdown } = buildDraft({ name, url, snippet, fullText }, scored);
    writeFileSync(join(DRAFTS, filename), markdown);
    drafted++;
    seen.add(threadId);
  }
} catch (err) {
  log("ERROR:", err?.message || err);
  if (!ctx) notify("LinkedIn assistant", `Browser launch failed: ${err?.message || err}`);
} finally {
  seen.save();
  if (counted) {
    try {
      writeState(STATE_FILE, { count: unreadCount });
    } catch (e) {
      log("notify: writeState failed:", e?.message);
    }
  } else {
    log("notify: scan failed before counting — keeping previous badge state");
  }
  await ctx?.close();
}

log(`Done. Scanned ${scanned} unread, wrote ${drafted} draft(s) to ${DRAFTS}`);
process.exit(0);
