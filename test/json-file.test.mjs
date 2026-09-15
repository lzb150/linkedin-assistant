import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/json-file.mjs";

test("readJson: parsed value, or the fallback for a missing / malformed file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ok.json"), '{"a":1}');
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readJson(join(dir, "ok.json"), {}), { a: 1 });
  assert.deepEqual(readJson(join(dir, "bad.json"), { d: true }), { d: true });
  assert.equal(readJson(join(dir, "missing.json"), null), null);
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
