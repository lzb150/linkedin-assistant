// The scheduled job. Reuses the session saved by login.mjs, reads UNREAD message
// threads, scores each against your resume profile, and writes a draft reply for
// any relevant one. IT NEVER SENDS ANYTHING and never clicks "Send".
//
// Run:  node check.mjs              (headless; UNREAD threads only, via LinkedIn's own
//                                     ?filter=unread list — see the note at the goto below)
//       HEADFUL=1 node check.mjs    (watch it work — useful for fixing selectors)
//       MAX=10 node check.mjs       (cap how many threads to open)
//       SCAN_ALL=1 node check.mjs   (scan recent threads regardless of read state;
//                                     useful for a first pass. seen.json still prevents
//                                     duplicate drafts. Does not touch the Dock badge.)

import { launchBrowser, LINKEDIN_LOGGED_OUT } from "./lib/browser.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage, looksLikeJobMessage } from "./lib/relevance.mjs";
import { threadIdFrom, threadOutcome, threadOpened, unreadVerdict } from "./lib/inbox.mjs";
import { buildDraft } from "./lib/draft.mjs";
import { writeState } from "./lib/notify-state.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { writeTextAtomic } from "./lib/json-file.mjs";
import { log, notify, ensureJobsApp } from "./lib/notify.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const DRAFTS = join(__dir, "drafts");
mkdirSync(DRAFTS, { recursive: true }); // fresh clone has no drafts/ yet
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
  // Rendered inside the list container when ?filter=unread has nothing to show.
  emptyUnread: "No unread messages",
  participantName: ".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names, [class*='participant-names']",
  // The open thread's own header title (no card to read when LinkedIn auto-opened it);
  // the first message group's sender name is the fallback.
  threadParticipantName: ".msg-entity-lockup__entity-title, .msg-thread__link-to-profile, .msg-s-message-group__name",
  messageBubble: ".msg-s-event-listitem__body, .msg-s-message-group__content",
};

// Thread ids already processed; entries expire after 90 days so the file
// stops growing forever.
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
  // /messaging/ auto-opens the newest thread on load, and an opened thread is
  // read: every hourly check was silently reading the newest message before
  // the unread scan ran (2026-09-14: a 14:50 message, 0 unread at 14:53; only
  // one detection in three months of logs, when two threads were unread at
  // once). LinkedIn's own unread filter lists exactly the unread threads and
  // does not auto-open when empty; opening its first card is what we do anyway.
  const INBOX = SCAN_ALL ? "https://www.linkedin.com/messaging/" : "https://www.linkedin.com/messaging/?filter=unread";
  await page.goto(INBOX, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Detect a logged-out session early and bail with a clear message.
  if (LINKEDIN_LOGGED_OUT.test(page.url())) {
    log("❌ Not logged in (session expired). Run:  node login.mjs");
    notify("LinkedIn assistant", "Session expired — run `node login.mjs` to re-authenticate.");
    await ctx.close();
    process.exit(2);
  }

  // Selector drift is not "inbox empty": without the list we must not zero the badge.
  const listFound = await page.waitForSelector(SEL.conversationList, { timeout: 20000 }).then(() => true, () => false);
  if (!listFound) log("⚠️  Conversation list selector not found — LinkedIn DOM may have changed. Run with HEADFUL=1 to inspect.");
  // The list container renders before its cards: a manual run at 15:18 (2026-09-14)
  // found 0 cards and no empty-state text while one unread thread was there.
  // Wait for a card, the empty-state text, or an auto-opened thread url (the
  // filtered list may have dropped that thread already, so no card ever comes).
  // The predicate names what it saw, so the empty-state check runs in one place.
  const settled = listFound && await page.waitForFunction((S) =>
    (location.pathname.includes("/messaging/thread/") && "thread")
    || (document.querySelector(S.conversationCard) && "cards")
    || ([...document.querySelectorAll(S.conversationList)].some((e) => e.innerText.includes(S.emptyUnread)) && "empty"),
  SEL, { timeout: 15000 }).then((h) => h.jsonValue(), () => null);
  // The url flips to the thread before the list renders: give the cards (or the
  // empty-state text) up to 3 s more, else the count below reads a list that is not there yet.
  if (settled === "thread") await page.waitForFunction((S) => document.querySelector(S.conversationCard) || [...document.querySelectorAll(S.conversationList)].some((e) => e.innerText.includes(S.emptyUnread)), SEL, { timeout: 3000 }).catch(() => {});

  // Collect candidate conversation cards.
  const cards = await page.$$(SEL.conversationCard);
  log(`Found ${cards.length} conversation cards.`);

  // Keep the Dock-badge daemon (Jobs.app) alive, then count ALL unread threads
  // (independent of MAX and the job-relevance filter) — this drives the badge.
  ensureJobsApp();
  // On the unread filter every card is unread. If LinkedIn auto-opened the first
  // one (url is a thread), the list may already have dropped it as read: decided
  // by id (is the open thread among the cards' hrefs?), not by count — with 2+
  // unread an empty-list check missed it, so it was never scanned and the badge
  // showed N−1. Do not read an empty list as drift then. A rendered list with
  // zero cards and no thread is either LinkedIn's empty state (honest 0) or the
  // card selector drifting (must not zero the badge) — the text decides.
  const autoOpened = /\/messaging\/thread\//.test(page.url());
  const openId = autoOpened ? threadIdFrom(page.url()) : null;
  const ids = await page.$$eval(`${SEL.conversationCard} a[href*='/messaging/thread/']`, (as) => as.map((a) => a.href)).then((hrefs) => hrefs.map((h) => threadIdFrom(h)), () => []);
  const openListed = autoOpened && ids.includes(openId);
  const verdict = unreadVerdict({ cards: cards.length, autoOpened, openListed, emptyState: settled === "empty", listFound, scanAll: SCAN_ALL });
  ({ unreadCount, counted } = verdict);
  if (!SCAN_ALL) log(`Unread threads: ${unreadCount}`);
  if (verdict.drift) log("⚠️  Empty list without the empty-state text — card selector may have drifted. Run with HEADFUL=1 to inspect.");

  // Threads to scan: the listed cards — preceded, when the auto-opened thread was
  // already dropped from the filtered list, by the open thread itself (`null`
  // card): opening it marked it read, so this run is the last chance to draft for it.
  const targets = verdict.scanOpenFirst ? [null, ...cards] : cards;
  if (verdict.scanOpenFirst) log("· auto-opened thread not in list — scanning it first");
  for (const [i, card] of targets.entries()) {
    // MAX caps opened threads; drafted threads are already counted in scanned.
    if (scanned >= MAX) break;

    let name = "Recruiter";
    try {
      const nameEl = await (card ? card.$(SEL.participantName) : page.$(SEL.threadParticipantName));
      if (nameEl) name = (await nameEl.innerText()).trim().split("\n")[0] || name;
    } catch {}

    // Open the thread and verify we landed on THIS card's thread (threadOpened),
    // else skip rather than misattribute the still-open previous thread to it.
    // The auto-opened thread is already open: nothing to click or verify.
    if (card) {
      let href = null;
      try { const hrefEl = await card.$("a[href*='/messaging/thread/']"); href = await hrefEl?.getAttribute("href"); } catch {}
      const wantId = href?.match(/thread\/([^/?#]+)/)?.[1];
      const before = page.url();
      await card.click().catch(() => {});
      // Wait for THIS thread's url (up to 5 s) instead of a fixed 1.5 s: on a slow
      // LinkedIn the late navigation used to land inside the next card's window.
      if (wantId) await page.waitForURL((u) => u.href.includes(wantId), { timeout: 5000 }).catch(() => {});
      else await page.waitForTimeout(1500);
      // `i` is the index within `targets` on purpose: threadOpened's "card 0 may keep
      // its url" rule is for the auto-opened card, and with the `null` target first
      // that card is NOT listed — the first real card must change the url like any other.
      if (!threadOpened({ wantId, url: page.url(), before, index: i })) { log(`· could not open thread, skipping: ${name}`); continue; }
    }
    const url = page.url();
    scanned++; // count only threads we actually opened, so a stalled LinkedIn doesn't burn the cap

    // Read the message bubbles (most recent incoming text).
    let bubbles = [], oldest = "", extractFailed = false, bubbleCount = 0;
    try {
      const els = await page.$$(SEL.messageBubble);
      bubbleCount = els.length;
      if (els.length) oldest = (await els[0].innerText()).trim();
      for (const el of els.slice(-12)) {
        const t = (await el.innerText()).trim();
        if (t) bubbles.push(t);
      }
    } catch (e) { extractFailed = true; log(`  bubble extraction failed: ${e?.message}`); }
    const fullText = bubbles.join("\n");
    const snippet = bubbles.slice(-1)[0] || "";

    const threadId = threadIdFrom(url, name, oldest);
    const { action, markSeen } = threadOutcome({ bubbleCount, text: fullText, extractFailed, alreadySeen: seen.has(threadId), isJob: looksLikeJobMessage(fullText) });
    if (markSeen) seen.add(threadId);   // "already" re-stamps so the TTL is "last seen"
    if (action === "already") { log(`· already processed: ${name}`); continue; }
    if (action === "retry") { log(`· ${bubbleCount ? "extraction failed" : "no message bubbles (selector drift?)"} — skipping without marking seen: ${name}`); continue; }
    if (action === "not-job") { log(`· not a job message, skipping: ${name}`); continue; }

    const scored = scoreMessage(fullText);
    log(`· ${name}: score=${scored.score} verdict=${scored.verdict} [${scored.matchedSkills.join(",")}]`);

    if (scored.verdict === "ignore") { seen.add(threadId); continue; }

    const { filename, markdown } = buildDraft({ name, url, snippet, fullText }, scored);
    writeTextAtomic(join(DRAFTS, filename), markdown);   // a crash mid-write must not leave a half-written draft
    drafted++;
    seen.add(threadId);
  }
} catch (err) {
  log("ERROR:", err?.message || err);
  // "profile busy" = benign overlap with another run (jobs.mjs/login.mjs); log only.
  if (!ctx && !/profile busy/.test(err?.message || "")) notify("LinkedIn assistant", `Browser launch failed: ${err?.message || err}`);
} finally {
  // Must not throw: writeState and ctx.close below still have to run.
  try { seen.save(); } catch (e) { log("seen.save failed:", e?.message); }
  if (counted) {
    try {
      writeState(STATE_FILE, { count: unreadCount });
    } catch (e) {
      log("notify: writeState failed:", e?.message);
    }
  } else if (!SCAN_ALL) {
    log("notify: scan failed before counting — keeping previous badge state");
  }
  await ctx?.close();
}

log(`Done. Scanned ${scanned} unread, wrote ${drafted} draft(s) to ${DRAFTS}`);
process.exit(0);
