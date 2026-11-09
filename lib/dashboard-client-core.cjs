// Pure logic for the dashboard client. This file is INLINED as plain text
// into the generated HTML's <script> by dashboard.mjs, so it must be valid
// classic-script JS with zero DOM/network references (document, fetch,
// localStorage, window are all off-limits) — that same property makes it
// require()-able by node:test. The DOM glue (dashboard-client-dom.js) calls
// these functions as script-scope globals.

// Radar mode: the tool finds, you look. "viewed" is set automatically when a
// card is opened, "closed" is set by closed-check.mjs (board reports the
// vacancy inactive), never by a card button.
const STATUSES = ["viewed", "closed"];

// Longest private note: the server refuses a longer one (lib/job-state.mjs
// validatePatch), the textarea and the client cut to it. One number for all three.
const NOTE_MAX = 10000;

function statusOfEntry(entry) {
  const s = (entry || {}).status;
  return STATUSES.includes(s) ? s : "new";
}

// Apply a status/note patch to an entry. Shared with the server
// (lib/job-state.mjs wraps it and adds updatedAt). Returns the new entry, or
// null when it became empty.
function mergeEntryLocal(entry, patch) {
  const e = { ...entry };
  if ("status" in patch) {
    if (patch.status === "new") delete e.status;
    else e.status = patch.status;
  }
  if ("note" in patch) {
    if (!patch.note) delete e.note;
    else e.note = patch.note;
  }
  // Any non-empty status counts (like the server's normalize): an unknown one from a
  // newer build must survive a note edit through an older client, not get deleted.
  const empty = !((typeof e.status === "string" && e.status) || (e.note && e.note.length));
  return empty ? null : e;
}

// The header tab a card answers to. An unseen borderline card waits under the
// "borderline" tab, not New: the New tab is for matches, and a 62 must not sit
// between two 85s. Once marked Viewed (or Closed) it leaves that tab like any
// other card, keeping its borderline tag.
function tabOf(card) {
  return card.tier === "borderline" && card.status === "new" ? "borderline" : card.status;
}

// The applyFilter predicate. card = { status, tier, source, search, detailsOpen };
// filters = { statusSel: string[], srcSel: string[], query }. Empty selections
// mean "All"; an open card never hides under it.
function cardMatches(card, filters) {
  const matchFind =
    (filters.srcSel.length === 0 || filters.srcSel.includes(card.source)) &&
    (!filters.query || card.search.includes(filters.query));
  const matchStatus =
    filters.statusSel.length === 0 ||
    filters.statusSel.includes(tabOf(card)) ||
    card.detailsOpen;
  return matchFind && matchStatus;
}

// Boards with a card under the status tabs alone (no source chip, no search):
// a source chip shows only while its board has something there, so a board
// with no New jobs has no chip in the New view.
function sourcesShown(cards, statusSel) {
  const out = new Set();
  for (const card of cards) if (cardMatches(card, { statusSel, srcSel: [], query: "" })) out.add(card.source);
  return out;
}

// A job is "new since last visit" when generated after the stored lastVisit.
function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO), v = Date.parse(lastVisitISO);
  if (!isFinite(g) || !isFinite(v)) return false;
  return g > v;
}

// lastVisit after a visit: the newest package ON THIS PAGE, never "now". A page
// can be older than the visit (a reload during a jobs.mjs run, a failed
// rebuild), and "now" then swallowed the NEW ribbon of every package written
// after the build, which this page never showed. Never moves backwards.
// A time in the future (a package `generated` on a clock that ran ahead, or a
// stored value from one) is ignored: it would pin lastVisit there and no later
// package could be NEW again. The server refuses such a lastVisit too.
const FUTURE_SLACK_MS = 5 * 60_000;
function visitedUpTo(generatedList, stored, now = Date.now()) {
  const ok = (t) => isFinite(t) && t <= now + FUTURE_SLACK_MS;
  const s = Date.parse(stored);
  let best = ok(s) ? s : 0;
  for (const g of generatedList) { const t = Date.parse(g); if (ok(t) && t > best) best = t; }
  return new Date(best).toISOString();
}

// Override patch for the `fields` of one local entry that were edited, so
// pushing it makes the server's copy of those fields identical (a missing field
// clears the server's value too) and leaves the others alone: a status set
// meanwhile (closed-check) must not be rolled back by a note edited offline.
// A status this build does not know (newer closed-check / dashboard) was never
// edited here, so it is left out of the patch rather than pushed as "new"
// (which would delete it).
function entryToPatch(entry, fields = ["note", "status"]) {
  const e = entry || {};
  const p = {};
  if (fields.includes("note")) p.note = e.note || "";
  if (fields.includes("status") && (!e.status || STATUSES.includes(e.status))) p.status = statusOfEntry(e);
  return p;
}

// What to push to the server on reconnect. `dirty` lists urls edited while
// offline (including deletions — a dirty url with no local entry pushes a
// clearing patch); `fields` maps a url to the fields edited, a url without one
// (recorded by an older build) pushes both.
function offlinePatches(local, dirty, fields = {}) {
  return dirty.map((url) => ({ url, patch: entryToPatch(local[url], fields[url]) }));
}

// In the browser this file is a plain inlined script — `module` is undefined
// and the tail is skipped; under node:test it exposes the API.
if (typeof module !== "undefined") {
  module.exports = {
    STATUSES, NOTE_MAX, FUTURE_SLACK_MS, statusOfEntry, mergeEntryLocal, tabOf, cardMatches, sourcesShown, isNew, visitedUpTo,
    entryToPatch, offlinePatches,
  };
}
