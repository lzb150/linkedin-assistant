import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("readStore tolerates malformed JSON", (t) => {
  const dir = tmp(t);
  const p = join(dir, "job-state.json");
  writeFileSync(p, "{ not json");
  assert.deepEqual(readStore(p), { _meta: {} });
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
