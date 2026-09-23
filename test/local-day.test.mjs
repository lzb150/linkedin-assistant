import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay } from "../lib/local-day.mjs";

// localDay only ever calls getFullYear/getMonth/getDate, so a stub pins the
// behaviour without depending on the machine's timezone — these assertions hold
// identically on a developer's laptop and on a TZ=UTC CI runner.
const stub = (year, month, date, utc = {}) => ({
  getFullYear: () => year,
  getMonth: () => month,
  getDate: () => date,
  // Deliberately wrong UTC view: any implementation reaching for these instead
  // of the local getters produces a different day and fails the test below.
  getUTCFullYear: () => utc.year ?? 1970,
  getUTCMonth: () => utc.month ?? 0,
  getUTCDate: () => utc.date ?? 1,
});

test("localDay pads month and day to two digits", () => {
  assert.equal(localDay(stub(2026, 0, 5)), "2026-01-05");   // getMonth is 0-based
  assert.equal(localDay(stub(2026, 11, 31)), "2026-12-31");
  assert.equal(localDay(stub(2026, 8, 15)), "2026-09-15");
});

test("localDay reads the LOCAL calendar day, not the UTC one", () => {
  // 00:30 local on 1 Jan is still 31 Dec in UTC east of Greenwich. Filenames and
  // report headings key off the local day, so the UTC answer would be wrong.
  assert.equal(localDay(stub(2026, 0, 1, { year: 2025, month: 11, date: 31 })), "2026-01-01");
});

test("localDay defaults to now and never emits the small-ICU en-US format", () => {
  // toLocaleDateString("sv-SE") returns this shape only on a full-ICU build; a
  // small-ICU Node hands back "9/15/2026", whose slashes break copyFileSync.
  const now = new Date();
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDay(), localDay(now));
  assert.equal(localDay().slice(0, 4), String(now.getFullYear()));
});
