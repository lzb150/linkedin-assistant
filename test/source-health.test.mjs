import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentCounts, normalizeHistory, median, detectDegradations, appendHistory, formatAlert, HISTORY_LEN,
} from "../lib/source-health.mjs";

// Build a minimal run-summary-shaped object for tests.
function summaryOf(counts) {
  const sources = {};
  for (const [s, found] of Object.entries(counts)) sources[s] = { found };
  return { sources };
}

test("currentCounts extracts found for every source that ran", () => {
  assert.deepEqual(currentCounts(summaryOf({ dou: 12, jooble: 0 })), { dou: 12, jooble: 0 });
});

test("normalizeHistory passes arrays through and drops garbage", () => {
  assert.deepEqual(normalizeHistory({ dou: [1, 2], bad: "x", worse: null }), { dou: [1, 2] });
  assert.deepEqual(normalizeHistory(null), {});
  assert.deepEqual(normalizeHistory("junk"), {});
  assert.deepEqual(normalizeHistory([1, 2, 3]), {}); // top-level array is garbage too
});

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), 0);
});

test("detectDegradations flags a source well below its recent norm", () => {
  const history = { linkedin: [50, 48, 52, 55, 49] };
  assert.deepEqual(
    detectDegradations(history, summaryOf({ linkedin: 6 })),
    [{ source: "linkedin", found: 6, median: 50 }],
  );
});

test("detectDegradations subsumes the old drop-to-zero alert", () => {
  assert.deepEqual(
    detectDegradations({ dou: [25] }, summaryOf({ dou: 0 })),
    [{ source: "dou", found: 0, median: 25 }],
  );
});

test("detectDegradations ignores healthy sources and mild dips", () => {
  assert.deepEqual(detectDegradations({ dou: [50] }, summaryOf({ dou: 20 })), []); // 20 >= 15
});

test("detectDegradations ignores sources with a tiny norm (median < 5)", () => {
  assert.deepEqual(detectDegradations({ niche: [3, 4, 3] }, summaryOf({ niche: 0 })), []);
});

test("detectDegradations ignores sources with no history", () => {
  assert.deepEqual(detectDegradations({}, summaryOf({ newsrc: 0 })), []);
});

test("appendHistory appends and trims to HISTORY_LEN, keeps absent sources", () => {
  const history = { dou: Array.from({ length: HISTORY_LEN }, (_, i) => i), linkedin: [4] };
  const out = appendHistory(history, { dou: 99 });
  assert.equal(out.dou.length, HISTORY_LEN);
  assert.equal(out.dou.at(-1), 99);
  assert.equal(out.dou[0], 1);            // oldest entry dropped
  assert.deepEqual(out.linkedin, [4]);    // untouched when the source didn't run
});

test("detectDegradations reports a source that never succeeded (>=5 all-zero runs)", () => {
  assert.deepEqual(
    detectDegradations({ workua: [0, 0, 0, 0, 0] }, summaryOf({ workua: 0 })),
    [{ source: "workua", found: 0, median: 0, reason: "never-succeeded", runs: 5 }],
  );
  assert.deepEqual(detectDegradations({ workua: [0, 0, 0, 0] }, summaryOf({ workua: 0 })), []); // too few runs
  assert.deepEqual(detectDegradations({ workua: [0, 0, 0, 0, 0] }, summaryOf({ workua: 3 })), []); // finally worked
  assert.deepEqual(detectDegradations({ workua: [0, 0, 0, 0, 0] }, summaryOf({ dou: 5 })), []); // absent this run
});

test("detectDegradations reports a healthy source that stopped running at all", () => {
  // A source disabled by a config typo never reaches summary.sources, so both
  // other rules are blind to it — the loop simply stops seeing it and the
  // source disappears for good with a clean log. Its history is the evidence
  // that it used to work.
  assert.deepEqual(
    detectDegradations({ djinni: [20, 18, 22, 19, 21] }, summaryOf({ dou: 12 })),
    [{ source: "djinni", found: 0, median: 20, reason: "absent", runs: 5 }],
  );
  // A source that never worked and is now gone is not news (guards the
  // "absent this run" case the never-succeeded test already pins).
  assert.deepEqual(detectDegradations({ workua: [0, 0, 0, 0, 0] }, summaryOf({ dou: 5 })), []);
  // Present and healthy → nothing.
  assert.deepEqual(detectDegradations({ dou: [10, 10, 10] }, summaryOf({ dou: 12 })), []);
});

test("formatAlert renders an absent source with a config hint", () => {
  assert.equal(
    formatAlert([{ source: "djinni", found: 0, median: 20, reason: "absent", runs: 5 }]),
    "⚠️ djinni: not run at all (recent median 20) — disabled or misspelt in jobs.config.json?",
  );
});

test("formatAlert renders never-succeeded", () => {
  assert.equal(
    formatAlert([{ source: "workua", found: 0, median: 0, reason: "never-succeeded", runs: 7 }]),
    "⚠️ workua: never returned results in 7 runs",
  );
});

test("formatAlert renders degradations", () => {
  assert.equal(
    formatAlert([{ source: "linkedin", found: 6, median: 50 }, { source: "dou", found: 0, median: 25 }]),
    "⚠️ linkedin: 6 found (recent median 50); dou: 0 found (recent median 25)",
  );
});
