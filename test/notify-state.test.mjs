import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../lib/notify-state.mjs";

// creates a temp dir and registers its removal via t.after so cleanup
// runs even when an assert throws
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "ns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("writeState then readState round-trips count and pending", (t) => {
  const dir = tmp(t);
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 2, pending: [{ id: "a", sender: "Helen", text: "hi" }] });
  const s = readState(p);
  assert.equal(s.count, 2);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].sender, "Helen");
  assert.ok(s.updatedAt);
});

test("readState returns defaults for a missing file", () => {
  const s = readState("/no/such/notify-state.json");
  assert.deepEqual(s, { count: 0, pending: [], updatedAt: "" });
});

test("readState tolerates malformed JSON", (t) => {
  const dir = tmp(t);
  const p = join(dir, "notify-state.json");
  writeFileSync(p, "{ not json");
  const s = readState(p);
  assert.equal(s.count, 0);
  assert.deepEqual(s.pending, []);
});

test("writeState clamps negative/fractional count to a non-negative integer", (t) => {
  const dir = tmp(t);
  const p = join(dir, "notify-state.json");
  writeState(p, { count: -3 });
  assert.equal(readState(p).count, 0);
  writeState(p, { count: 2.9 });
  assert.equal(readState(p).count, 2);
});

test("writeState defaults pending to an empty array", (t) => {
  const dir = tmp(t);
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 0 });
  assert.deepEqual(readState(p).pending, []);
});
