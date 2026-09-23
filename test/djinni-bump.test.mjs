import test from "node:test";
import assert from "node:assert/strict";
import { dueForCheck, nextBumpState, freshThreads, bumpProfile } from "../lib/djinni-bump.mjs";

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

test("freshThreads: only threads not in the seen set notify; wording is singular/plural with the first labelled thread", () => {
  const threads = [{ id: "1", label: "" }, { id: "2", label: "Acme" }, { id: "3", label: "Beta" }];
  assert.deepEqual(freshThreads(threads, ["2", "3"]), { fresh: [{ id: "1", label: "" }], message: "New message" });
  assert.deepEqual(freshThreads(threads, [1]).message, "2 new messages (incl. Acme)", "seen ids are compared as strings");
  assert.deepEqual(freshThreads(threads, ["1", "3"]), { fresh: [{ id: "2", label: "Acme" }], message: "New message: Acme" });
  assert.deepEqual(freshThreads(threads, "garbage").fresh.length, 3, "a non-array seen file means nothing was seen");
  assert.deepEqual(freshThreads([], []), { fresh: [], message: "0 new messages" });
  assert.deepEqual(freshThreads(threads, ["1", "2", "3"]).fresh, [], "nothing new — the caller does not notify");
});

// bumpProfile against a fake Playwright page: `button` is the bump button's
// state (null = missing), `modalText` what the confirm modal shows (undefined =
// no modal ever appears). The confirm click is recorded so a test can prove an
// unrelated modal was never pressed.
function fakeProfilePage({ button, modalText }) {
  const calls = [];
  const btn = {
    count: async () => (button ? 1 : 0),
    isDisabled: async () => button === "disabled" || (button === "enabled" && calls.includes("confirm")),   // Djinni disables it once the bump lands
    getAttribute: async () => null,
    click: async () => calls.push("open"),
  };
  const modal = {
    waitFor: async () => { if (modalText === undefined) throw new Error("timeout"); },
    innerText: async () => modalText,
    locator: () => ({ first: () => ({ click: async () => calls.push("confirm") }) }),
  };
  return { calls, goto: async () => {}, reload: async () => {}, waitForTimeout: async () => {}, locator: (sel) => ({ first: () => (sel.startsWith("button") ? btn : modal) }) };
}

test("bumpProfile: missing button → unverified, disabled → cooldown, unrelated modal → unverified without pressing it, bump modal → bumped", async () => {
  assert.equal(await bumpProfile(fakeProfilePage({ button: null })), "unverified");
  assert.equal(await bumpProfile(fakeProfilePage({ button: "disabled" })), "cooldown");
  const survey = fakeProfilePage({ button: "enabled", modalText: "Take our 2-minute survey" });
  assert.equal(await bumpProfile(survey), "unverified");
  assert.deepEqual(survey.calls, ["open"], "the survey's first button was never clicked");
  const bump = fakeProfilePage({ button: "enabled", modalText: "Bump my profile?" });
  assert.equal(await bumpProfile(bump), "bumped");
  assert.deepEqual(bump.calls, ["open", "confirm"]);
  assert.equal(await bumpProfile(fakeProfilePage({ button: "enabled" })), "unverified", "no modal and the button stays enabled — nothing registered");
});
