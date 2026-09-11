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

function statusOfEntry(entry) {
  const s = (entry || {}).status;
  return STATUSES.includes(s) ? s : "new";
}

// Apply a status/note patch to an entry. Shared with the server
// (lib/job-state.mjs wraps it and adds updatedAt). Returns the new entry, or
// null when it became empty.
function mergeEntryLocal(entry, patch) {
  const e = { ...(entry || {}) };
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

// The applyFilter predicate. card = { status, source, search, detailsOpen };
// filters = { statusSel: string[], srcSel: string[], query }. Empty selections
// mean "All"; an open card never hides under it.
function cardMatches(card, filters) {
  const matchFind =
    (filters.srcSel.length === 0 || filters.srcSel.includes(card.source)) &&
    (!filters.query || card.search.includes(filters.query));
  const matchStatus =
    filters.statusSel.length === 0 ||
    filters.statusSel.includes(card.status) ||
    card.detailsOpen;
  return matchFind && matchStatus;
}

// A job is "new since last visit" when generated after the stored lastVisit.
function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO), v = Date.parse(lastVisitISO);
  if (!isFinite(g) || !isFinite(v)) return false;
  return g > v;
}

// Full-override patch for one local entry, so pushing it makes the server's
// copy identical (a missing field clears the server's value too).
function entryToPatch(entry) {
  const e = entry || {};
  return { status: statusOfEntry(e), note: e.note || "" };
}

// What to push to the server on reconnect. `dirty` lists urls edited while
// offline (including deletions — a dirty url with no local entry pushes a
// clearing patch).
function offlinePatches(local, dirty) {
  return dirty.map((url) => ({ url, patch: entryToPatch(local[url]) }));
}

// In the browser this file is a plain inlined script — `module` is undefined
// and the tail is skipped; under node:test it exposes the API.
if (typeof module !== "undefined") {
  module.exports = {
    STATUSES, statusOfEntry, mergeEntryLocal, cardMatches, isNew,
    entryToPatch, offlinePatches,
  };
}
