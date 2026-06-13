import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatNotification,
} from "../lib/run-summary.mjs";

test("recordFound tallies raw counts into a lazily-created source bucket", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "dou", 0);
  assert.equal(s.sources.dou.found, 12);
  assert.equal(s.sources.dou.excluded, 0);
});

test("recordOutcome increments only the four known outcome kinds", () => {
  const s = newSummary();
  recordOutcome(s, "djinni", "seen");
  recordOutcome(s, "djinni", "seen");
  recordOutcome(s, "djinni", "written");
  recordOutcome(s, "djinni", "bogus"); // ignored
  assert.equal(s.sources.djinni.seen, 2);
  assert.equal(s.sources.djinni.written, 1);
  assert.equal(s.sources.djinni.found, 0); // not touched by outcomes
});

test("recordTop keeps the maximum score and ignores lower ones", () => {
  const s = newSummary();
  recordTop(s, 30, "A");
  recordTop(s, 42, "B");
  recordTop(s, 27, "C");
  assert.equal(s.top.score, 42);
  assert.equal(s.top.label, "B");
});

test("formatTable shows a row per source and the header", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordOutcome(s, "dou", "written");
  recordFound(s, "jooble", 5);
  const out = formatTable(s);
  assert.match(out, /Run summary/);
  assert.match(out, /found.*excl.*seen.*low.*NEW/);
  assert.match(out, /dou/);
  assert.match(out, /jooble/);
});

test("formatTable shows the merged line only when merged > 0", () => {
  const s = newSummary();
  recordFound(s, "dou", 1);
  assert.doesNotMatch(formatTable(s), /merged/);
  recordMerged(s, 2);
  assert.match(formatTable(s), /merged 2 cross-source duplicate\(s\)/);
});

test("formatTable shows the top-score line only when a top exists", () => {
  const s = newSummary();
  recordFound(s, "dou", 1);
  assert.doesNotMatch(formatTable(s), /top score/);
  recordTop(s, 42, "Senior AQA @ Acme");
  assert.match(formatTable(s), /top score: 42 \(Senior AQA @ Acme\)/);
});

test("formatNotification lists only sources with written matches plus the top", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "jooble", 5);
  recordOutcome(s, "dou", "written");
  recordOutcome(s, "dou", "written");
  recordOutcome(s, "dou", "written");
  recordTop(s, 42, "Senior AQA @ Acme");
  const out = formatNotification(s);
  assert.match(out, /dou 3 new/);
  assert.doesNotMatch(out, /jooble/); // 0 written
  assert.match(out, /top 42/);
});

test("formatNotification reports scanned total when nothing was written", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "jooble", 5);
  recordOutcome(s, "dou", "seen");
  assert.equal(formatNotification(s), "No new matches · scanned 17");
});
