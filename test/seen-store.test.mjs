import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadSeenStore } from "../lib/seen-store.mjs";
import { tmpDir } from "./helpers/e2e.mjs";
import { writeJsonAtomic } from "../lib/json-file.mjs";

test("writeJsonAtomic writes the value and leaves no temp file", (t) => {
  const p = join(tmpDir(t), "seen.json");
  writeJsonAtomic(p, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { a: 1 });
  assert.throws(() => readFileSync(`${p}.${process.pid}.tmp`));
  assert.deepEqual(readdirSync(dirname(p)), ["seen.json"]);
});

test("writeJsonAtomic leaves no temp file and no clobbered target when the write fails", (t) => {
  const p = join(tmpDir(t), "seen.json");
  writeJsonAtomic(p, { ok: 1 });
  assert.throws(() => writeJsonAtomic(p, { big: 1n })); // BigInt is not serialisable
  assert.deepEqual(readdirSync(dirname(p)), ["seen.json"]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { ok: 1 });
});

test("seen-store add() on an existing key refreshes the stamp to last-seen", (t) => {
  const p = join(tmpDir(t), "seen.json");
  writeFileSync(p, JSON.stringify({ a: "2026-08-01T00:00:00.000Z" }));
  const s = loadSeenStore(p, { now: Date.parse("2026-08-26T00:00:00Z") });
  s.add("a").save();
  assert.equal(JSON.parse(readFileSync(p, "utf8")).a, "2026-08-26T00:00:00.000Z");
});

test("loadSeenStore moves a corrupt file to .corrupt and starts fresh", (t) => {
  const p = join(tmpDir(t), "seen.json");
  writeFileSync(p, "{not json");
  const warnings = [];
  const s = loadSeenStore(p, { warn: (m) => warnings.push(m) });
  assert.equal(s.size, 0);
  assert.equal(readFileSync(`${p}.corrupt`, "utf8"), "{not json");
  assert.equal(warnings.length, 1);
  // missing file is NOT corrupt: no warning, no sibling
  loadSeenStore(join(dirname(p), "none.json"), { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
});

test("loadSeenStore drops entries older than the TTL", (t) => {
  const p = join(tmpDir(t), "seen.json");
  const now = Date.parse("2026-08-26T00:00:00Z");
  writeFileSync(p, JSON.stringify({ old: "2026-01-01T00:00:00Z", fresh: "2026-08-01T00:00:00Z", junk: "nope" }));
  const s = loadSeenStore(p, { now, ttlDays: 90 });
  assert.equal(s.has("old"), false);
  assert.equal(s.has("fresh"), true);
  assert.equal(s.has("junk"), false);
  assert.equal(s.size, 1);
});
