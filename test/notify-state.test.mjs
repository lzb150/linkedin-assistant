import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeState } from "../lib/notify-state.mjs";
import { tmpDir } from "./helpers/e2e.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

test("writeState writes count, pending and updatedAt as the Jobs.app daemon reads them", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  const s = writeState(p, { count: 2, pending: [{ id: "a", sender: "Helen", text: "hi" }] });
  assert.deepEqual(read(p), s);
  assert.equal(s.count, 2);
  assert.equal(s.pending[0].sender, "Helen");
  assert.ok(Date.parse(s.updatedAt));
});

test("writeState clamps negative/fractional count and defaults pending to []", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  writeState(p, { count: -3 });
  assert.equal(read(p).count, 0);
  assert.deepEqual(read(p).pending, []);
  writeState(p, { count: 2.9, pending: "nope" });
  assert.equal(read(p).count, 2);
  assert.deepEqual(read(p).pending, []);
});
