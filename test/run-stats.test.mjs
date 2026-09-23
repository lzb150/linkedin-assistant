// The per-run counter file that replaced regex-parsing jobs.mjs's own log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendRunStat, readRunStats } from "../lib/run-stats.mjs";
import { tmpDir } from "./helpers/e2e.mjs";

test("appendRunStat writes one line per run and readRunStats reads them back", (t) => {
  const f = join(tmpDir(t), "run-stats.jsonl");
  appendRunStat(f, { considered: 3, written: 1, dropped: 2, failed: 0 }, new Date("2026-09-14T09:00:00Z"));
  appendRunStat(f, { considered: 4, written: 2, dropped: 1, failed: 1 }, new Date("2026-09-15T09:00:00Z"));
  assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 2, "appended, not overwritten");
  const all = readRunStats(f);
  assert.equal(all.length, 2);
  assert.equal(all[1].considered, 4);
});

test("readRunStats filters by the window and survives a torn line", (t) => {
  const f = join(tmpDir(t), "run-stats.jsonl");
  writeFileSync(f, [
    JSON.stringify({ at: "2026-09-01T09:00:00Z", considered: 99 }),
    '{"at":"2026-09-14T09:00:00Z","conside',   // a crash mid-append
    JSON.stringify({ at: "2026-09-15T09:00:00Z", considered: 4 }),
    "",
  ].join("\n"));
  const got = readRunStats(f, { since: Date.parse("2026-09-10T00:00:00Z") });
  assert.deepEqual(got.map((e) => e.considered), [4], "old line filtered, torn line skipped, not thrown");
});

test("a missing file is not an error, and appending never throws", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readRunStats(join(dir, "nope.jsonl")), []);
  assert.doesNotThrow(() => appendRunStat(join(dir, "no", "such", "dir", "x.jsonl"), { considered: 1 }));
});

test("appendRunStat caps the file instead of growing for the life of the install", (t) => {
  // Everything else with a lifetime is bounded — jobs-seen.json by TTL, logs/ at
  // 30 days, archived packages at 180 — but this file only ever appended, and
  // the weekly digest reads all of it.
  const file = join(tmpDir(t, "rs-"), "run-stats.jsonl");
  for (let i = 0; i < 8; i++) appendRunStat(file, { considered: i }, new Date(2026, 0, 1, i), { maxLines: 5 });
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 5, "trimmed to the cap");
  assert.deepEqual(lines.map((l) => JSON.parse(l).considered), [3, 4, 5, 6, 7], "the newest entries survive");
  assert.equal(readRunStats(file).length, 5, "and the file is still parseable after the rewrite");
});

test("a failed line-cap trim is reported, even though a failed append stays silent", (t) => {
  // The two used to share one catch. Swallowing the append is deliberate — the
  // run's work is already on disk. Swallowing the trim meant the file could grow
  // past MAX_LINES forever with nothing to notice it by, and the cap is the one
  // thing this module promises.
  const dir = tmpDir(t);
  const file = join(dir, "run-stats.jsonl");
  const many = Array.from({ length: 12 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), n: i })).join("\n") + "\n";
  writeFileSync(file, many);
  const warns = [];
  // writeTextAtomic writes "<file>.<pid>.tmp" then renames; a DIRECTORY at that
  // path makes the trim (and only the trim) fail.
  mkdirSync(`${file}.${process.pid}.tmp`);
  appendRunStat(file, { considered: 1 }, new Date(), { maxLines: 5, warn: (s) => warns.push(s) });
  assert.equal(warns.length, 1, "the trim failure is reported exactly once");
  assert.match(warns[0], /could not trim/);
  assert.ok(readFileSync(file, "utf8").split("\n").filter(Boolean).length > 5, "the append still landed");
});
