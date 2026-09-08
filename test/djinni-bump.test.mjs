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

test("nextBumpState: cooldown near the expected end of the 7-day cooldown re-checks hourly, otherwise daily", () => {
  const DAY = 86400000, HOUR = 3600000;
  const last = new Date(NOW - 6.5 * DAY).toISOString();          // 12 h before the expected end → hourly
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: last, nextCheckAt: "" }, "cooldown", NOW).nextCheckAt), NOW + HOUR);
  const justAfter = new Date(NOW - 7.5 * DAY).toISOString();     // 12 h past the expected end, still cooldown → keep trying hourly one more day
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: justAfter, nextCheckAt: "" }, "cooldown", NOW).nextCheckAt), NOW + HOUR);
  const early = new Date(NOW - 3 * DAY).toISOString();           // mid-cooldown → daily
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: early, nextCheckAt: "" }, "cooldown", NOW).nextCheckAt), NOW + DAY);
  const wayPast = new Date(NOW - 9 * DAY).toISOString();         // Djinni changed the rule → back to daily, never hourly forever
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: wayPast, nextCheckAt: "" }, "cooldown", NOW).nextCheckAt), NOW + DAY);
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: "", nextCheckAt: "" }, "cooldown", NOW).nextCheckAt), NOW + DAY, "unknown last bump → daily");
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: last, nextCheckAt: "" }, "unverified", NOW).nextCheckAt), NOW + DAY, "only a cooldown answer speeds up");
});

test("nextBumpState anchors nextCheckAt to the start of the hour, so launchd's jittered hourly runs never skip a slot", () => {
  const DAY = 86400000, HOUR = 3600000;
  const late = NOW + 17 * 60000;                                   // launchd fired 17 min late (observed)
  const last = new Date(late - 6.5 * DAY).toISOString();           // inside the hourly window
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: last, nextCheckAt: "" }, "cooldown", late).nextCheckAt), NOW + HOUR, "next slot, not now+1h");
  assert.equal(Date.parse(nextBumpState({ lastBumpAt: "", nextCheckAt: "" }, "cooldown", late).nextCheckAt), NOW + DAY, "same-hour slot tomorrow, not now+24h");
  assert.ok(dueForCheck({ nextCheckAt: nextBumpState({ lastBumpAt: last, nextCheckAt: "" }, "cooldown", late).nextCheckAt }, NOW + HOUR + 3000), "a run 3 s into the next hour is due");
});

test("nextBumpState: cooldown/unverified keep lastBumpAt and retry in a day", () => {
  for (const outcome of ["cooldown", "unverified"]) {
    const s = nextBumpState({ lastBumpAt: "2026-08-15T00:00:00.000Z", nextCheckAt: "" }, outcome, NOW);
    assert.equal(s.lastBumpAt, "2026-08-15T00:00:00.000Z");
    assert.equal(s.nextCheckAt, new Date(NOW + DAY).toISOString());
  }
});
