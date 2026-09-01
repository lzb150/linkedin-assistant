import test from "node:test";
import assert from "node:assert/strict";
import { dueForCheck, nextBumpState } from "../lib/djinni-bump.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

test("dueForCheck: empty/garbage nextCheckAt means due", () => {
  assert.equal(dueForCheck({ lastBumpAt: "", nextCheckAt: "" }, NOW), true);
  assert.equal(dueForCheck({ lastBumpAt: "", nextCheckAt: "not a date" }, NOW), true);
});

test("dueForCheck: future date defers, past date is due", () => {
  assert.equal(dueForCheck({ nextCheckAt: new Date(NOW + 1000).toISOString() }, NOW), false);
  assert.equal(dueForCheck({ nextCheckAt: new Date(NOW - 1000).toISOString() }, NOW), true);
});

test("nextBumpState: bumped records lastBumpAt and rechecks in a day", () => {
  const s = nextBumpState({ lastBumpAt: "", nextCheckAt: "" }, "bumped", NOW);
  assert.equal(s.lastBumpAt, new Date(NOW).toISOString());
  assert.equal(s.nextCheckAt, new Date(NOW + DAY).toISOString());
});

test("nextBumpState: cooldown/unverified keep lastBumpAt and retry in a day", () => {
  for (const outcome of ["cooldown", "unverified"]) {
    const s = nextBumpState({ lastBumpAt: "2026-08-15T00:00:00.000Z", nextCheckAt: "" }, outcome, NOW);
    assert.equal(s.lastBumpAt, "2026-08-15T00:00:00.000Z");
    assert.equal(s.nextCheckAt, new Date(NOW + DAY).toISOString());
  }
});
