// Pure logic for the dashboard client. This file is INLINED as plain text
// into the generated HTML's <script> by dashboard.mjs, so it must be valid
// classic-script JS with zero DOM/network references (document, fetch,
// localStorage, window are all off-limits) — that same property makes it
// require()-able by node:test. The DOM glue (dashboard-client-dom.js) calls
// these functions as script-scope globals.

const STATUSES = ["viewed", "applied", "answered", "interview", "rejected"];
const POST_APPLIED = ["applied", "answered", "interview", "rejected"];

function statusOfEntry(entry) {
  const s = (entry || {}).status;
  return STATUSES.includes(s) ? s : "new";
}

// Apply a status/appliedAt/note patch to an entry. Shared with the server
// (lib/job-state.mjs wraps it and adds updatedAt). Returns the new entry, or
// null when it became empty.
function mergeEntryLocal(entry, patch) {
  const e = { ...(entry || {}) };
  if ("status" in patch) {
    if (patch.status === "new") delete e.status;
    else e.status = patch.status;
  }
  if ("appliedAt" in patch) {
    if (patch.appliedAt == null) delete e.appliedAt;
    else e.appliedAt = patch.appliedAt;
  }
  if ("note" in patch) {
    if (!patch.note) delete e.note;
    else e.note = patch.note;
  }
  const empty = !(STATUSES.includes(e.status) || (e.note && e.note.length) || e.appliedAt);
  return empty ? null : e;
}

// The applyFilter predicate. card = { status, source, score, search, fresh,
// detailsOpen }; filters = { statusSel: string[], srcSel: string[], minScore,
// query }. Empty selections mean "All"; an open card never hides under it.
function cardMatches(card, filters) {
  const matchFind =
    (filters.srcSel.length === 0 || filters.srcSel.includes(card.source)) &&
    card.score >= filters.minScore &&
    (!filters.query || card.search.includes(filters.query));
  const matchStatus =
    filters.statusSel.length === 0 ||
    filters.statusSel.includes(card.status) ||
    (filters.statusSel.includes("fresh") && card.fresh) ||
    card.detailsOpen;
  return matchFind && matchStatus;
}

// Funnel math over [{ status, source }]. "Answered" is any post-applied
// movement — a rejection is a response too.
function computeFunnel(cards) {
  const out = { applied: 0, answered: 0, interview: 0, rejected: 0, bySrc: {} };
  for (const card of cards) {
    if (!POST_APPLIED.includes(card.status)) continue;
    out.applied++;
    const s = (out.bySrc[card.source] = out.bySrc[card.source] || { a: 0, r: 0, i: 0 });
    s.a++;
    if (card.status !== "applied") { out.answered++; s.r++; }
    if (card.status === "interview") { out.interview++; s.i++; }
    if (card.status === "rejected") out.rejected++;
  }
  return out;
}

function formatFunnel(f) {
  if (!f.applied) return "";
  const pct = (x, y) => (y ? Math.round((x / y) * 100) + "%" : "—");
  const src = Object.entries(f.bySrc).map(([k, s]) => `${k} ${s.a}/${s.r}/${s.i}`).join(" · ");
  return `Funnel: ${f.applied} applied → ${f.answered} answered (${pct(f.answered, f.applied)}) → ${f.interview} interview (${pct(f.interview, f.answered)})`
    + (f.rejected ? ` · ${f.rejected} rejected` : "")
    + (src ? `  ·  applied/answered/interview by source: ${src}` : "");
}

function daysAgo(iso, nowMs = Date.now()) {
  const d = (nowMs - new Date(iso).getTime()) / 86400000;
  if (!isFinite(d)) return "";
  const n = Math.floor(d);
  return n <= 0 ? "today" : n + "d ago";
}

// A job is "new since last visit" when generated after the stored lastVisit.
function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO), v = Date.parse(lastVisitISO);
  if (!isFinite(g) || !isFinite(v)) return false;
  return g > v;
}

// In the browser this file is a plain inlined script — `module` is undefined
// and the tail is skipped; under node:test it exposes the API.
if (typeof module !== "undefined") {
  module.exports = {
    STATUSES, POST_APPLIED, statusOfEntry, mergeEntryLocal,
    cardMatches, computeFunnel, formatFunnel, daysAgo, isNew,
  };
}
