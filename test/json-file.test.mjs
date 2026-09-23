import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/json-file.mjs";

test("readJson: parsed value, fallback ONLY for a missing file, throws on a malformed one", (t) => {
  // The malformed case was asserted the other way round until the callers were
  // audited: every failure yielded the fallback, and the two callers that write
  // this same file back (source-health.json, closed-check-state.json) then
  // persisted that fallback — one corrupt read silently replaced the
  // accumulated state, and the fresh data written over it hid the loss.
  // "Missing" still means "start empty"; anything else is now the caller's
  // decision to make out loud.
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ok.json"), '{"a":1}');
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readJson(join(dir, "ok.json"), {}), { a: 1 });
  assert.equal(readJson(join(dir, "missing.json"), null), null, "ENOENT is still a fresh start");
  assert.throws(() => readJson(join(dir, "bad.json"), { d: true }), /JSON/, "a corrupt file must not look like an empty one");
  assert.throws(() => readJson(dir, null), { code: "EISDIR" }, "nor may any other read error");
});

test("writeJsonAtomic round-trips through readJson and leaves no .tmp behind", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeJsonAtomic(join(dir, "s.json"), { x: [1, 2] });
  assert.deepEqual(readJson(join(dir, "s.json"), null), { x: [1, 2] });
  assert.deepEqual(readdirSync(dir), ["s.json"]);
});

// writeSync can return short; writeFileSync loops. A truncated file here would
// be exactly the half-written state the module exists to prevent.
test("writeTextAtomic writes a payload larger than one pipe buffer in full", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const big = "x".repeat(8 * 1024 * 1024);
  writeTextAtomic(join(dir, "big.txt"), big);
  assert.equal(readFileSync(join(dir, "big.txt"), "utf8").length, big.length);
});

// The 0600 is documented as applying to REWRITES too, not only to files this
// call creates: rename(2) swaps in the tmp inode, so the previous mode is gone.
// Pinned so the comment and the behaviour cannot drift apart again.
test("writeTextAtomic re-creates an existing file as 0600, whatever mode it had", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");
  writeFileSync(file, "{}");
  chmodSync(file, 0o644);
  assert.equal(statSync(file).mode & 0o777, 0o644, "precondition: the file starts out group/world-readable");
  writeTextAtomic(file, '{"a":1}');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');
});
