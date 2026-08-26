import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSeenStore } from "../lib/seen-store.mjs";
import { writeJsonAtomic } from "../lib/json-file.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "seen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "seen.json");
}

test("writeJsonAtomic writes the value and leaves no temp file", (t) => {
  const p = tmp(t);
  writeJsonAtomic(p, { a: 1 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { a: 1 });
  assert.throws(() => readFileSync(`${p}.tmp`));
});

test("loadSeenStore migrates a legacy array and persists as { key: iso }", (t) => {
  const p = tmp(t);
  writeFileSync(p, JSON.stringify(["a", "b"]));
  const s = loadSeenStore(p, { now: Date.parse("2026-08-26T00:00:00Z") });
  assert.ok(s.has("a") && s.has("b") && !s.has("c"));
  s.add("c").save();
  const disk = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(Object.keys(disk).sort(), ["a", "b", "c"]);
  assert.equal(disk.a, "2026-08-26T00:00:00.000Z");
});

test("loadSeenStore drops entries older than the TTL", (t) => {
  const p = tmp(t);
  const now = Date.parse("2026-08-26T00:00:00Z");
  writeFileSync(p, JSON.stringify({ old: "2026-01-01T00:00:00Z", fresh: "2026-08-01T00:00:00Z", junk: "nope" }));
  const s = loadSeenStore(p, { now, ttlDays: 90 });
  assert.equal(s.has("old"), false);
  assert.equal(s.has("fresh"), true);
  assert.equal(s.has("junk"), false);
  assert.equal(s.size, 1);
});

test("loadSeenStore starts fresh on a missing file or a legacy file flagged stale", (t) => {
  const p = tmp(t);
  assert.equal(loadSeenStore(p).size, 0);
  writeFileSync(p, JSON.stringify(["https://x/1"]));
  const s = loadSeenStore(p, { isLegacy: (a) => a.some((e) => e.startsWith("http")) });
  assert.equal(s.size, 0);
});
