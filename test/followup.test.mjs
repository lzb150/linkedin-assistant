import { test } from "node:test";
import assert from "node:assert/strict";
import { dueReminders } from "../lib/followup.mjs";

const now = new Date("2026-06-20T12:00:00Z");
const daysBefore = (n) => new Date(now.getTime() - n * 86400000).toISOString();

test("includes an applied job older than the threshold", () => {
  const map = { "u1": { status: "applied", appliedAt: daysBefore(8) } };
  const out = dueReminders({ stateMap: map, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "u1");
  assert.equal(out[0].daysSince, 8);
});

test("excludes jobs younger than the threshold", () => {
  const map = { "u1": { status: "applied", appliedAt: daysBefore(3) } };
  assert.equal(dueReminders({ stateMap: map, now }).length, 0);
});

test("excludes non-applied jobs and already-notified urls", () => {
  const map = {
    "u1": { status: "viewed", appliedAt: daysBefore(30) },
    "u2": { status: "applied", appliedAt: daysBefore(30) },
    "u3": { status: "applied", appliedAt: daysBefore(30) },
  };
  const out = dueReminders({ stateMap: map, now, alreadyNotified: ["u2"] });
  assert.deepEqual(out.map((r) => r.url), ["u3"]);
});

test("ignores _meta and entries without appliedAt", () => {
  const map = { _meta: { lastVisit: "x" }, "u1": { status: "applied" } };
  assert.equal(dueReminders({ stateMap: map, now }).length, 0);
});

test("post-applied stages are never reminded (answered/interview/rejected)", () => {
  const old = "2026-06-01T00:00:00Z";
  const stateMap = {
    "https://a/": { status: "answered", appliedAt: old },
    "https://b/": { status: "interview", appliedAt: old },
    "https://c/": { status: "rejected", appliedAt: old },
    "https://d/": { status: "applied", appliedAt: old },
  };
  const due = dueReminders({ stateMap, now: "2026-07-30T00:00:00Z", thresholdDays: 7 });
  assert.deepEqual(due.map((d) => d.url), ["https://d/"]);
});
