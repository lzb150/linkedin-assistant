import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../lib/dashboard-client-core.cjs");

test("statusOfEntry: stored statuses pass through, everything else is new", () => {
  for (const st of ["viewed", "closed"]) {
    assert.equal(core.statusOfEntry({ status: st }), st, st);
  }
  assert.equal(core.statusOfEntry(undefined), "new");
  assert.equal(core.statusOfEntry({}), "new");
  assert.equal(core.statusOfEntry({ status: "ghosted" }), "new");
  assert.equal(core.statusOfEntry({ status: "applied" }), "new", "pre-radar status reads as new");
});

const baseFilters = { statusSel: [], srcSel: [], query: "" };
const baseCard = { status: "new", source: "dou", search: "sdet acme playwright", detailsOpen: false };

test("cardMatches: empty selections mean All", () => {
  assert.equal(core.cardMatches(baseCard, baseFilters), true);
});

test("cardMatches: status multi-select, details-open override", () => {
  const filters = { ...baseFilters, statusSel: ["closed"] };
  assert.equal(core.cardMatches(baseCard, filters), false);
  assert.equal(core.cardMatches({ ...baseCard, status: "closed" }, filters), true);
  assert.equal(core.cardMatches({ ...baseCard, detailsOpen: true }, filters), true); // open card never hides
});

test("cardMatches: source and query narrow the list", () => {
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, srcSel: ["linkedin"] }), false);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "acme" }), true);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "golang" }), false);
});

test("isNew: baseline rules", () => {
  assert.equal(core.isNew("2026-07-30T10:00:00Z", ""), false);            // no baseline yet
  assert.equal(core.isNew("2026-07-30T10:00:00Z", "2026-07-29T00:00:00Z"), true);
  assert.equal(core.isNew("2026-07-28T10:00:00Z", "2026-07-29T00:00:00Z"), false);
  assert.equal(core.isNew("junk", "2026-07-29T00:00:00Z"), false);
});

test("offlinePatches: dirty urls push full-override patches, deletions clear", () => {
  const local = {
    _meta: { lastVisit: "x" },
    "https://a/": { status: "closed", note: "hi" },
    "https://b/": { status: "viewed" },
    "https://c/": { status: "viewed" },
  };
  const server = { _meta: {}, "https://a/": { status: "viewed" }, "https://d/": { status: "closed" } };
  // Dirty tracking: only a (edited existing) and d (deleted offline) go out; b/c untouched.
  assert.deepEqual(core.offlinePatches(local, ["https://a/", "https://d/"]), [
    { url: "https://a/", patch: { status: "closed", note: "hi" } },
    { url: "https://d/", patch: { status: "new", note: "" } },
  ]);
  assert.deepEqual(core.offlinePatches(local, []), []);
  // The clearing patch really empties an entry via the shared merge.
  assert.equal(core.mergeEntryLocal(server["https://d/"], core.entryToPatch(undefined)), null);
  // A status this build does not know (newer closed-check/dashboard) survives a
  // note edit through this client — locally and in the patch pushed on reconnect.
  assert.deepEqual(core.mergeEntryLocal({ status: "from-the-future" }, { note: "x" }), { status: "from-the-future", note: "x" });
  assert.deepEqual(core.entryToPatch({ status: "from-the-future", note: "x" }), { note: "x" }, "unknown status is left out, not pushed as new");
});
