import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatRunBanner,
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

test("formatRunBanner: alerts first, then new packages strongest-first, capped at 3 labels", () => {
  const w = [
    { score: 90, llmScore: null, label: "kw-only" },  // LLM failed → outranked by every LLM-scored entry
    { score: 45, llmScore: 71, label: "B" },
    { score: 40, llmScore: 88, label: "A" },
    { score: 40, llmScore: 75, label: "C" },
  ];
  assert.equal(formatRunBanner(w), "4 new: A, C, B, …");
  assert.equal(formatRunBanner(w.slice(1), ["⚠️ dou: 0 found (recent median 12)"]),
    "⚠️ dou: 0 found (recent median 12) · 3 new: A, C, B");
});

test("formatRunBanner is empty when nothing was written and nothing broke — an empty run posts no banner", () => {
  assert.equal(formatRunBanner([]), "");
  assert.equal(formatRunBanner(undefined, []), "");
  assert.equal(formatRunBanner([], ["⚠️ LLM failed 3× — keyword-only packages"]), "⚠️ LLM failed 3× — keyword-only packages");
});
