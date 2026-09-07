import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMeta } from "../lib/job-state.mjs";
import {
  normalize, mergeEntry, validatePatch, readStore, writeStore, statusOf,
} from "../lib/job-state.mjs";

const U = "https://example.com/jobs/1/";
// creates a temp dir and registers its removal via t.after so cleanup
// runs even when an assert throws
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "js-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("normalize upgrades the legacy string shape to an entry object", () => {
  const out = normalize({ [U]: "viewed" });
  assert.equal(out[U].status, "viewed");
  assert.ok(out[U].updatedAt);
  assert.deepEqual(out._meta, {});
});

test("normalize preserves _meta and drops fully-empty entries", () => {
  const out = normalize({ _meta: { lastVisit: "2026-06-20T00:00:00Z" }, [U]: {} });
  assert.equal(out._meta.lastVisit, "2026-06-20T00:00:00Z");
  assert.equal(out[U], undefined);
});

test("normalize keeps a note-only entry (status defaults to new)", () => {
  const out = normalize({ [U]: { note: "call Anna" } });
  assert.equal(out[U].note, "call Anna");
  assert.equal(statusOf(out, U), "new");
});

test("mergeEntry sets status + appliedAt without mutating the input", () => {
  const before = {};
  const after = mergeEntry(before, U, { status: "applied", appliedAt: "2026-06-15T10:00:00Z" });
  assert.equal(after[U].status, "applied");
  assert.equal(after[U].appliedAt, "2026-06-15T10:00:00Z");
  assert.ok(after[U].updatedAt);
  assert.deepEqual(before, {}); // unchanged
});

test("mergeEntry with status new deletes the entry when nothing else remains", () => {
  const after = mergeEntry({ [U]: { status: "viewed" } }, U, { status: "new" });
  assert.equal(after[U], undefined);
});

test("mergeEntry keeps the entry when a note remains after clearing status", () => {
  const after = mergeEntry({ [U]: { status: "viewed", note: "x" } }, U, { status: "new" });
  assert.equal(after[U].status, undefined);
  assert.equal(after[U].note, "x");
});

test("validatePatch rejects an unknown status and accepts a valid one", () => {
  assert.equal(validatePatch({ status: "offer" }), false);
  assert.equal(validatePatch({ status: "applied" }), true);
  assert.equal(validatePatch({ appliedAt: null, note: "ok" }), true);
  assert.equal(validatePatch({ note: 5 }), false);
});

test("readStore round-trips through writeStore atomically", (t) => {
  const dir = tmp(t);
  const p = join(dir, "job-state.json");
  writeStore(p, mergeEntry({ _meta: { lastVisit: "t" } }, U, { status: "applied", appliedAt: "a" }));
  const back = readStore(p);
  assert.equal(back[U].status, "applied");
  assert.equal(back._meta.lastVisit, "t");
});

test("readStore returns an empty store for a missing file", () => {
  assert.deepEqual(readStore("/no/such/job-state.json"), { _meta: {} });
});

test("readStore throws on malformed JSON (a corrupt store must never be silently emptied)", (t) => {
  const dir = tmp(t);
  const p = join(dir, "job-state.json");
  writeFileSync(p, "{ not json");
  assert.throws(() => readStore(p), SyntaxError);
});

test("normalize keeps the new post-applied statuses", () => {
  for (const st of ["answered", "interview", "rejected"]) {
    const out = normalize({ [U]: { status: st } });
    assert.equal(out[U].status, st, st);
    assert.equal(statusOf(out, U), st);
  }
});

test("validatePatch accepts the new statuses and still rejects junk", () => {
  for (const st of ["answered", "interview", "rejected"]) {
    assert.equal(validatePatch({ status: st }), true, st);
  }
  assert.equal(validatePatch({ status: "ghosted" }), false);
});

test("mergeEntry keeps appliedAt when moving applied → answered", () => {
  let map = mergeEntry({}, U, { status: "applied", appliedAt: "2026-07-01T00:00:00Z" });
  map = mergeEntry(map, U, { status: "answered" });
  assert.equal(map[U].status, "answered");
  assert.equal(map[U].appliedAt, "2026-07-01T00:00:00Z");
});

test("normalizeMeta keeps only lastVisit and canonicalizes it to toISOString() form", () => {
  assert.deepEqual(normalizeMeta({ lastVisit: "2026-06-20T09:00:00Z", junk: 1 }), { lastVisit: "2026-06-20T09:00:00.000Z" });
  assert.deepEqual(normalizeMeta({ lastVisit: "2026-06-20T09:00:00.123Z" }), { lastVisit: "2026-06-20T09:00:00.123Z" });
  for (const bad of [{}, { lastVisit: "t" }, { lastVisit: "" }, [], null, "x"]) assert.equal(normalizeMeta(bad), null);
});

// A long-running state server (started before a deploy) must not delete
// entries whose status it does not know yet: on 2026-09-07 the old server's
// first POST normalized 448 fresh "closed" entries away. Unknown statuses are
// kept verbatim on disk and merely read as "new" until the server restarts.
test("normalize keeps entries with a status this build does not know", () => {
  const out = normalize({ _meta: {}, "u1": { status: "from-the-future", updatedAt: "2026-09-07T00:00:00Z" }, "u2": { status: "viewed" } });
  assert.equal(out.u1.status, "from-the-future");
  assert.equal(out.u2.status, "viewed");
  assert.equal(statusOf(out, "u1"), "new", "unknown reads as new for display");
});

// Daily snapshots: the first writeStore of a day copies the previous file to
// job-state.<YYYY-MM-DD>.bak (never overwritten that day), keeping the last 7.
// A single ".bak" would be replaced by the next dashboard click seconds after
// a bad write — as happened on 2026-09-07, when a stale server wiped 448 entries.
test("writeStore keeps one snapshot per day, never overwrites it, prunes to 7", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, "job-state.json");
  const day = (n) => new Date(Date.UTC(2026, 8, n, 12));   // Sep n, 2026
  const snaps = () => readdirSync(dir).filter((f) => /^job-state\.\d{4}-\d{2}-\d{2}\.bak$/.test(f)).sort();

  writeStore(p, { _meta: {}, u1: { status: "viewed" } }, { now: day(1) });
  assert.deepEqual(snaps(), [], "nothing to snapshot before the first file exists");

  writeStore(p, { _meta: {}, u1: { status: "applied" } }, { now: day(2) });
  assert.deepEqual(snaps(), ["job-state.2026-09-02.bak"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "job-state.2026-09-02.bak"), "utf8")).u1.status, "viewed", "snapshot holds the file as it was before the day's first write");

  writeStore(p, { _meta: {} }, { now: day(2) });   // second write the same day (a wipe, say)
  assert.equal(JSON.parse(readFileSync(join(dir, "job-state.2026-09-02.bak"), "utf8")).u1.status, "viewed", "same-day writes never touch the snapshot");

  for (let n = 3; n <= 10; n++) writeStore(p, { _meta: {}, u1: { status: "viewed" } }, { now: day(n) });
  assert.equal(snaps().length, 7);
  assert.deepEqual(snaps()[0], "job-state.2026-09-04.bak", "oldest snapshots pruned");
});
