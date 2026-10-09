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
//                                     duplicate drafts — keyed on THEIR newest message, so
//                                     your own reply never re-drafts a thread. No banners,
//                                     does not touch the Dock badge.)

import { LINKEDIN_LOGGED_OUT } from "./lib/browser.mjs";
import { runScan } from "./lib/scan-run.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage, looksLikeJobMessage } from "./lib/relevance.mjs";
import { threadIdFrom, messageKey, threadState, threadOutcome, threadOpened, unreadVerdict } from "./lib/inbox.mjs";
import { buildDraft } from "./lib/draft.mjs";
import { writeState, readPending, readBadge, linkedinBadge, keepBadgeAdding } from "./lib/notify-state.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { writeTextAtomic } from "./lib/json-file.mjs";
import { log, notify, ensureJobsApp } from "./lib/notify.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const DRAFTS = join(__dir, "drafts");
mkdirSync(DRAFTS, { recursive: true, mode: 0o700 }); // fresh clone has no drafts/ yet; drafts quote recruiter messages — owner-only
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
  // The card's link div while its thread is the open one. Since ~2026-09-15 the
  // card is no <a>: no href, no thread id anywhere in it (live DOM 2026-10-07),
  // so this class is the only tie between a card and the open thread.
  activeCardLink: ".msg-conversations-container__convo-item-link--active",
  // Rendered inside the list container when ?filter=unread has nothing to show.
  emptyUnread: "No unread messages",
  participantName: ".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names, [class*='participant-names']",
  // The open thread's own header title (no card to read when LinkedIn auto-opened it);
  // the first message group's sender name is the fallback.
  threadParticipantName: ".msg-entity-lockup__entity-title, .msg-thread__link-to-profile, .msg-s-message-group__name",
  messageBubble: ".msg-s-event-listitem__body, .msg-s-message-group__content",
  // One per message; `--other` marks the ones THEY sent (checked on the live DOM
  // 2026-09-28: 19 items, 7 incoming, the newest two your own replies).
  messageItem: ".msg-s-event-listitem",
  incomingClass: "msg-s-event-listitem--other",
};

// Thread states already processed (thread id + their newest message, see messageKey); entries expire after 90 days so the file
// stops growing forever.
const seen = loadSeenStore(SEEN_FILE);

let drafted = 0;
let scanned = 0;
let unreadCount = 0;
// Threads ({ id, label }) remember() could not write to notify-state.json yet;
// finish() retries them. Pending threads keep the Dock badge until clicked.
const notified = [];
// Only overwrite the badge state when the scan actually counted the inbox —
// a navigation failure would otherwise reset the badge to 0 and hide unread
// messages until the next successful run.
let counted = false;
// A run that threw after launch used to log the error and still print "Done."
// and exit 0, so launchd and the user both saw a healthy run: runScan maps it
// to one 3-state outcome (ok | busy | failed).
const outcome = await runScan({ profile: PROFILE, app: "LinkedIn assistant", scan, finish });

async function scan(page, ctx) {
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
  // Cards without thread anchors (the current DOM): the open thread is listed
  // iff a card is marked active. Should that class drift too, the open thread
  // reads as dropped: badge N+1 and a second pass that finds it "already
  // processed" — the cheap side; assuming "listed" drops a real unread thread
  // unscanned and unbannered whenever 2+ were unread.
  const openListed = autoOpened && (ids.length ? ids.includes(openId) : await page.$(`${SEL.conversationCard} ${SEL.activeCardLink}`).then(Boolean));
  const verdict = unreadVerdict({ cards: cards.length, autoOpened, openListed, emptyState: settled === "empty", listFound, scanAll: SCAN_ALL });
  ({ unreadCount, counted } = verdict);
  if (!SCAN_ALL) log(`Unread threads: ${unreadCount}`);
  if (verdict.drift) log("⚠️  Empty list without the empty-state text — card selector may have drifted. Run with HEADFUL=1 to inspect.");

  // Threads to scan: the listed cards — preceded, when the auto-opened thread was
  // already dropped from the filtered list, by the open thread itself (`null`
  // card): opening it marked it read, so this run is the last chance to draft for it.
  const targets = verdict.scanOpenFirst ? [null, ...cards] : cards;
  if (verdict.scanOpenFirst) log("· auto-opened thread not in list — scanning it first");
  for (const card of targets) {
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
      // Already the open thread (LinkedIn auto-opened it): the url will not change.
      const wasActive = !wantId && await card.$(SEL.activeCardLink).then(Boolean).catch(() => false);
      // 5 s, not Playwright's 30 s default: a detached handle used to stall the
      // run inside this silent catch, up to ~6 min across the cards of one pass.
      await card.click({ timeout: 5000 }).catch(() => {});
      // Wait for THIS thread's url (up to 5 s) instead of a fixed 1.5 s: on a slow
      // LinkedIn the late navigation used to land inside the next card's window.
      if (wantId) await page.waitForURL((u) => u.href.includes(wantId), { timeout: 5000 }).catch(() => {});
      else if (!wasActive) {
        // No id to wait for: wait for this card to turn active, then for the url
        // to leave the previous thread (a fixed 1.5 s used to stand in for both).
        await card.waitForSelector(SEL.activeCardLink, { timeout: 5000 }).catch(() => {});
        await page.waitForURL((u) => u.href !== before && u.href.includes("/messaging/thread/"), { timeout: 5000 }).catch(() => {});
      }
      if (!threadOpened({ wantId, url: page.url(), before, wasActive })) { log(`· could not open thread, skipping: ${name}`); continue; }
    }
    const url = page.url();
    scanned++; // count only threads we actually opened, so a stalled LinkedIn doesn't burn the cap

    // Read the message bubbles (most recent incoming text).
    let bubbles = [], oldest = "", extractFailed = false, bubbleCount = 0, items = [];
    try {
      // The pane fills in after the url flips (live DOM 2026-09-28: 1 bubble at
      // first, 17 half a second later): wait until the count holds still, else
      // a partial list is hashed, scored and drafted.
      for (let prev = -1, t = 0; t < 4000; t += 400) {
        const n = (await page.$$(SEL.messageBubble)).length;
        if (n > 0 && n === prev) break;
        prev = n;
        await page.waitForTimeout(400);
      }
      items = await page.$$eval(SEL.messageItem, (els, S) => els.map((e) => ({
        incoming: e.classList.contains(S.incomingClass),
        text: (e.querySelector(S.messageBubble)?.innerText || "").trim(),
      })), SEL).catch(() => []);
      const els = await page.$$(SEL.messageBubble);
      bubbleCount = els.length;
      if (els.length) oldest = (await els[0].innerText()).trim();
      for (const el of els.slice(-12)) {
        const t = (await el.innerText()).trim();
        if (t) bubbles.push(t);
      }
    } catch (e) { extractFailed = true; log(`  bubble extraction failed: ${e?.message}`); }
    const fullText = bubbles.join("\n");
    // No list items (item selector drift): the bubbles stand in, direction unknown.
    const { state, snippet: newest } = threadState(items.length ? items : bubbles.map((text) => ({ incoming: false, text })));
    const snippet = newest || bubbles.slice(-1)[0] || "";

    const threadId = threadIdFrom(url, name, oldest);
    const seenKey = messageKey(threadId, state);
    // SCAN_ALL walks read threads too: a pre-#194 bare-id entry means "done", or
    // the first such run re-drafts every thread drafted before the key change.
    const alreadySeen = seen.has(seenKey) || (SCAN_ALL && seen.has(threadId));
    const { action, markSeen } = threadOutcome({ bubbleCount, text: fullText, extractFailed, alreadySeen, isJob: looksLikeJobMessage(fullText) });
    if (markSeen) seen.add(seenKey);   // "already" re-stamps so the TTL is "last seen"
    if (action === "already") {
      // On the unread filter with nothing new since we last saw it: the owner
      // marked it unread in LinkedIn. Opening it just marked it read again, and
      // `opened` subtracts it from the count — so keep it on the badge until a
      // Dock click. No banner: there is nothing new to announce.
      if (!SCAN_ALL) remember({ id: threadId, label: name });
      log(`· already processed: ${name}`);
      continue;
    }
    // Opening the thread just marked it read, so the Dock badge drops it on the
    // next scan: a banner is the only lasting signal of a new message. Posted
    // before the retry skip: the unread filter never lists a read thread again,
    // so a thread we could not read would otherwise vanish with a log line.
    if (!SCAN_ALL) {
      remember({ id: threadId, label: name });   // before the banner: a click on it reads this state
      notify("LinkedIn", `${name}: ${snippet.replace(/\s+/g, " ").slice(0, 140) || "new message (could not read it — open LinkedIn)"}`);
    }
    if (action === "retry") { log(`· ${bubbleCount ? "extraction failed" : "no message bubbles (selector drift?)"} — skipping without marking seen: ${name}`); continue; }
    if (action === "not-job") { log(`· not a job message, skipping: ${name}`); continue; }

    const scored = scoreMessage(fullText);
    log(`· ${name}: score=${scored.score} verdict=${scored.verdict} [${scored.matchedSkills.join(",")}]`);

    if (scored.verdict === "ignore") { seen.add(seenKey); continue; }

    const { filename, markdown } = buildDraft({ name, url, snippet, fullText }, scored);
    writeTextAtomic(join(DRAFTS, filename), markdown);   // a crash mid-write must not leave a half-written draft
    drafted++;
    seen.add(seenKey);
  }
}

// Each thread lands in notify-state.json as soon as it is bannered. Jobs.app
// posts a banner within ~3 s, and the state used to be written only at
// finish(), minutes later: a click on the banner read the previous run's
// state (opening the wrong place), cleared it, and finish() then re-added the
// clicked thread. Only a write that failed (or ran before a count) is left in
// `notified` for finish() to retry.
function remember(entry) {
  if (counted) {
    try { writeState(STATE_FILE, linkedinBadge({ prevPending: readPending(STATE_FILE), notified: [entry], unreadCount, opened: scanned })); return; }
    catch (e) { log("notify: writeState failed:", e?.message); }
  }
  notified.push(entry);
}

function finish({ held }) {
  // Only a run that actually held the profile may write seen.json back: on the
  // "profile busy" path this process loaded its snapshot before the lock holder
  // started adding entries, so saving here rolls that holder's work back.
  if (held) { try { seen.save(); } catch (e) { log("seen.save failed:", e?.message); } }
  if (counted) {
    try {
      // Read at finish, not at start: a Dock click during the run cleared the
      // threads bannered before it, and must stay cleared. `notified` holds
      // only what remember() could not write itself.
      writeState(STATE_FILE, linkedinBadge({ prevPending: readPending(STATE_FILE), notified, unreadCount, opened: scanned }));
    } catch (e) {
      log("notify: writeState failed:", e?.message);
    }
  } else if (!SCAN_ALL) {
    log("notify: scan failed before counting — keeping previous badge state");
    if (notified.length) {
      try { writeState(STATE_FILE, keepBadgeAdding({ prev: readBadge(STATE_FILE), notified })); }
      catch (e) { log("notify: writeState failed:", e?.message); }
    }
  }
}

if (outcome === "failed") {
  log(`FAILED after scanning ${scanned} unread, ${drafted} draft(s) written to ${DRAFTS}`);
  process.exit(1);
}
log(`${outcome === "busy" ? "Skipped (profile busy)." : "Done."} Scanned ${scanned} unread, wrote ${drafted} draft(s) to ${DRAFTS}`);
process.exit(0);
