import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../lib/notify-state.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "ns-")); }

test("writeState then readState round-trips count and pending", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 2, pending: [{ id: "a", sender: "Helen", text: "hi" }] });
  const s = readState(p);
  assert.equal(s.count, 2);
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].sender, "Helen");
  assert.ok(s.updatedAt);
  rmSync(dir, { recursive: true, force: true });
});

test("readState returns defaults for a missing file", () => {
  const s = readState("/no/such/notify-state.json");
  assert.deepEqual(s, { count: 0, pending: [], updatedAt: "" });
});

test("readState tolerates malformed JSON", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeFileSync(p, "{ not json");
  const s = readState(p);
  assert.equal(s.count, 0);
  assert.deepEqual(s.pending, []);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState clamps negative/fractional count to a non-negative integer", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: -3 });
  assert.equal(readState(p).count, 0);
  writeState(p, { count: 2.9 });
  assert.equal(readState(p).count, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("writeState defaults pending to an empty array", () => {
  const dir = tmp();
  const p = join(dir, "notify-state.json");
  writeState(p, { count: 0 });
  assert.deepEqual(readState(p).pending, []);
  rmSync(dir, { recursive: true, force: true });
});
