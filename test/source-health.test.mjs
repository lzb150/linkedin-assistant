import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentCounts, detectRegressions, mergeCounts, formatAlert,
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

test("detectRegressions flags a source that dropped from >0 to 0", () => {
  const prev = { dou: 25, djinni: 15 };
  assert.deepEqual(
    detectRegressions(prev, summaryOf({ dou: 0, djinni: 15 })),
    [{ source: "dou", was: 25 }],
  );
});

test("detectRegressions ignores a source that was already 0", () => {
  assert.deepEqual(detectRegressions({ jooble: 0 }, summaryOf({ jooble: 0 })), []);
});

test("detectRegressions ignores a source with no previous record", () => {
  assert.deepEqual(detectRegressions({}, summaryOf({ newsrc: 0 })), []);
});

test("detectRegressions does not flag a source that still has results", () => {
  assert.deepEqual(detectRegressions({ dou: 25 }, summaryOf({ dou: 10 })), []);
});

test("mergeCounts overwrites with current and retains sources absent this run", () => {
  const prev = { dou: 25, linkedin: 4 };
  const current = { dou: 0, djinni: 15 };
  assert.deepEqual(mergeCounts(prev, current), { dou: 0, linkedin: 4, djinni: 15 });
});

test("formatAlert renders one source", () => {
  assert.equal(formatAlert([{ source: "dou", was: 25 }]), "⚠️ dou returned 0 (was 25)");
});

test("formatAlert joins multiple sources with semicolons", () => {
  assert.equal(
    formatAlert([{ source: "dou", was: 25 }, { source: "jooble", was: 8 }]),
    "⚠️ dou returned 0 (was 25); jooble returned 0 (was 8)",
  );
});
