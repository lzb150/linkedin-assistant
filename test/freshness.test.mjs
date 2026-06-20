// test/freshness.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNew } from "../lib/freshness.mjs";

test("flags a job generated after the last visit", () => {
  assert.equal(isNew("2026-06-20T10:00:00Z", "2026-06-19T00:00:00Z"), true);
});
test("does not flag a job generated before the last visit", () => {
  assert.equal(isNew("2026-06-18T10:00:00Z", "2026-06-19T00:00:00Z"), false);
});
test("flags nothing when there is no last-visit baseline", () => {
  assert.equal(isNew("2026-06-20T10:00:00Z", ""), false);
  assert.equal(isNew("2026-06-20T10:00:00Z", undefined), false);
});
test("returns false for an unparseable generated date", () => {
  assert.equal(isNew("not-a-date", "2026-06-19T00:00:00Z"), false);
});
