// The per-run counter file that replaced regex-parsing jobs.mjs's own log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
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
