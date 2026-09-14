// Pure per-thread decisions for check.mjs (the inbox scanner has no browserless
// test path, so the logic that decides what a thread IS lives here).
import { createHash } from "node:crypto";

// Stable id from the thread url — the /thread/<id> segment only (query/hash
// must not leak into the seen key). URL-less fallback hashes name + the OLDEST
// bubble (not the first of the last-12 window, which shifts as replies arrive).
export function threadIdFrom(url, name, oldest) {
  const m = String(url || "").match(/thread\/([^/?#]+)/);
  return m ? m[1] : `name:${createHash("sha1").update(`${name}\n${oldest}`).digest("hex").slice(0, 12)}`;
}

// Did the click land on THIS card's thread? The card's own href (`wantId`) is
// the ground truth; without one, any url change counts — except for card 0,
// which LinkedIn auto-opens on load, so an unchanged url there is expected,
// not a failed click.
export function threadOpened({ wantId, url, before, index }) {
  return wantId ? url.includes(wantId) : (url !== before || index === 0);
}

// What to do with an opened thread. `markSeen` = suppress it for the seen TTL.
//   already  — processed on an earlier run (re-stamp so the TTL is "last seen")
//   retry    — extraction failed OR no message bubbles at all: an opened thread
//              always has one, so zero is selector drift, not content. Leave it
//              unseen so the next run retries instead of burying it for 90 days.
//   not-job  — bubbles exist but the text is not a job message
//   process  — score it and maybe draft a reply
export function threadOutcome({ bubbleCount, text, extractFailed, alreadySeen, isJob }) {
  if (alreadySeen) return { action: "already", markSeen: true };
  if (extractFailed || bubbleCount === 0) return { action: "retry", markSeen: false };
  if (!text || !isJob) return { action: "not-job", markSeen: true };
  return { action: "process", markSeen: false };
}

// How to read the unread list once it has settled. `cards` = listed cards (on
// ?filter=unread every one is unread); `autoOpened` = LinkedIn opened the first
// thread on load (url is a thread) — the filtered list may already have dropped
// it as read, so it still counts as one and an empty list is then not drift.
//   unreadCount — drives the Dock badge
//   counted     — the inbox was really counted; only then may the badge be written
//   drift       — a rendered list with no cards, no empty-state text and no open
//                 thread: the card selector has probably drifted
// SCAN_ALL walks the unfiltered list and leaves the badge alone.
export function unreadVerdict({ cards, autoOpened, emptyState, listFound, scanAll }) {
  if (scanAll) return { unreadCount: 0, counted: false, drift: false };
  return {
    unreadCount: Math.max(cards, autoOpened ? 1 : 0),
    counted: listFound && (cards > 0 || emptyState || autoOpened),
    drift: listFound && cards === 0 && !emptyState && !autoOpened,
  };
}
