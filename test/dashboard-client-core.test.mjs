import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../lib/dashboard-client-core.cjs");

test("statusOfEntry: stored statuses pass through, everything else is new", () => {
  for (const st of ["viewed", "applied", "answered", "interview", "rejected"]) {
    assert.equal(core.statusOfEntry({ status: st }), st, st);
  }
  assert.equal(core.statusOfEntry(undefined), "new");
  assert.equal(core.statusOfEntry({}), "new");
  assert.equal(core.statusOfEntry({ status: "ghosted" }), "new");
});

test("computeFunnel: empty board", () => {
  assert.deepEqual(core.computeFunnel([]), { applied: 0, answered: 0, interview: 0, rejected: 0, bySrc: {} });
});

test("computeFunnel: full funnel, rejection counts as a response", () => {
  const f = core.computeFunnel([
    { status: "new", source: "dou" },          // not in the funnel
    { status: "applied", source: "dou" },
    { status: "answered", source: "djinni" },
    { status: "interview", source: "linkedin" },
    { status: "rejected", source: "jooble" },
  ]);
  assert.equal(f.applied, 4);
  assert.equal(f.answered, 3);   // answered + interview + rejected
  assert.equal(f.interview, 1);
  assert.equal(f.rejected, 1);
  assert.deepEqual(f.bySrc.linkedin, { a: 1, r: 1, i: 1 });
  assert.deepEqual(f.bySrc.dou, { a: 1, r: 0, i: 0 });
});

test("formatFunnel: empty funnel renders nothing", () => {
  assert.equal(core.formatFunnel(core.computeFunnel([])), "");
});

test("formatFunnel: percentages, rejected tail, per-source breakdown", () => {
  const s = core.formatFunnel(core.computeFunnel([
    { status: "applied", source: "dou" },
    { status: "answered", source: "dou" },
    { status: "interview", source: "dou" },
    { status: "rejected", source: "dou" },
  ]));
  assert.match(s, /4 applied → 3 answered \(75%\) → 1 interview \(33%\)/);
  assert.match(s, /1 rejected/);
  assert.match(s, /dou 4\/3\/1/);
});

const baseFilters = { statusSel: [], srcSel: [], minScore: 0, query: "" };
const baseCard = { status: "new", source: "dou", score: 30, search: "sdet acme playwright", fresh: false, detailsOpen: false };

test("cardMatches: empty selections mean All", () => {
  assert.equal(core.cardMatches(baseCard, baseFilters), true);
});

test("cardMatches: status multi-select, fresh pseudo-status, details-open override", () => {
  const filters = { ...baseFilters, statusSel: ["applied"] };
  assert.equal(core.cardMatches(baseCard, filters), false);
  assert.equal(core.cardMatches({ ...baseCard, status: "applied" }, filters), true);
  assert.equal(core.cardMatches({ ...baseCard, fresh: true }, { ...baseFilters, statusSel: ["fresh"] }), true);
  assert.equal(core.cardMatches({ ...baseCard, detailsOpen: true }, filters), true); // open card never hides
});

test("cardMatches: source, min-score and query narrow the list", () => {
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, srcSel: ["linkedin"] }), false);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, minScore: 40 }), false);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "acme" }), true);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "golang" }), false);
});

test("daysAgo: today, n days, junk", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  assert.equal(core.daysAgo("2026-07-30T09:00:00Z", now), "today");
  assert.equal(core.daysAgo("2026-07-25T09:00:00Z", now), "5d ago");
  assert.equal(core.daysAgo("garbage", now), "");
});

test("isNew: baseline rules", () => {
  assert.equal(core.isNew("2026-07-30T10:00:00Z", ""), false);            // no baseline yet
  assert.equal(core.isNew("2026-07-30T10:00:00Z", "2026-07-29T00:00:00Z"), true);
  assert.equal(core.isNew("2026-07-28T10:00:00Z", "2026-07-29T00:00:00Z"), false);
  assert.equal(core.isNew("junk", "2026-07-29T00:00:00Z"), false);
});
