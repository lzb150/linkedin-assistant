// last-success.json: the watchdog that notices a launchd job that stopped finishing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stamp, staleJobs, heartbeat, normalizeHeartbeat, formatStale } from "../lib/heartbeat.mjs";
import { tmpDir } from "./helpers/e2e.mjs";

const T0 = Date.parse("2026-10-28T08:00:00Z");
const at = (h) => new Date(T0 + h * 3_600_000);
const limits = { check: { hours: 12, runs: 12 }, "jobs-dou": { hours: 12, runs: 12 } };

// check stamped once at T0, then only jobs-dou runs: `n` stamps spread over `hours`.
function quietCheck(n, hours) {
  let s = stamp({ tick: 0, jobs: {} }, "check", at(0));
  for (let i = 1; i <= n; i++) s = stamp(s, "jobs-dou", at((hours * i) / n));
  return s;
}

test("a job is stale only when old by the clock AND out-run by other jobs", () => {
  // 20 other runs but only 6 h old: the Mac was busy, check simply has not been due 12 h yet.
  assert.deepEqual(staleJobs(quietCheck(20, 6), { self: "jobs-dou", now: at(6), limits }), []);
  // 14 h old but only 3 runs happened: the Mac slept — not a dead job.
  assert.deepEqual(staleJobs(quietCheck(3, 14), { self: "jobs-dou", now: at(14), limits }), []);
  // 14 h old and 15 runs finished meanwhile: dead.
  const stale = staleJobs(quietCheck(15, 14), { self: "jobs-dou", now: at(14), limits });
  assert.deepEqual(stale, [{ job: "check", hours: 14, runs: 15 }]);
  assert.match(formatStale(stale), /check: no successful run for 14 h while 15 other runs finished/);
});

test("the stamping job never reports itself, and a job that never stamped is not expected", () => {
  const s = quietCheck(15, 14);
  assert.deepEqual(staleJobs(s, { self: "check", now: at(14), limits }).map((x) => x.job), [], "self excluded");
  assert.ok(!("djinni-check" in s.jobs), "nothing invented for jobs that never ran");
});

test("heartbeat alerts once per outage, again after a day, and clears on recovery", (t) => {
  const file = join(tmpDir(t), "last-success.json");
  const alerts = [];
  const alert = (m) => alerts.push(m);
  let s = quietCheck(14, 13);
  writeFileSync(file, JSON.stringify(s));
  heartbeat(file, "jobs-dou", { now: at(13.5), alert, limits });
  assert.equal(alerts.length, 1, "first stamp past the limit shouts");
  heartbeat(file, "jobs-dou", { now: at(14), alert, limits });
  heartbeat(file, "jobs-dou", { now: at(20), alert, limits });
  assert.equal(alerts.length, 1, "the same outage is not repeated every hour");
  heartbeat(file, "jobs-dou", { now: at(13.5 + 25), alert, limits });
  assert.equal(alerts.length, 2, "still down a day later → one reminder");
  heartbeat(file, "check", { now: at(40), alert, limits });   // check is back
  const state = normalizeHeartbeat(JSON.parse(readFileSync(file, "utf8")));
  assert.ok(Date.parse(state.jobs.check.at) > Date.parse(state.jobs.check.alertedAt), "recovery stamp is newer than the alert");
  // Down again later: a fresh outage alerts afresh (alertedAt is older than the last success).
  s = state;
  for (let i = 1; i <= 13; i++) s = stamp(s, "jobs-dou", at(40 + i));
  writeFileSync(file, JSON.stringify(s));
  heartbeat(file, "jobs-dou", { now: at(54), alert, limits });
  assert.equal(alerts.length, 3);
});

test("a torn file resets the history instead of killing the watchdog", (t) => {
  const file = join(tmpDir(t), "last-success.json");
  writeFileSync(file, '{"tick": 5, "jobs": {"check": {"at": "2026-10-');
  const lines = [];
  heartbeat(file, "jobs-dou", { now: at(0), log: (l) => lines.push(l), limits });
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(state.tick, 1);
  assert.deepEqual(Object.keys(state.jobs), ["jobs-dou"]);
  assert.ok(lines.some((l) => /heartbeat history reset/.test(l)), lines.join("\n"));
});

test("normalizeHeartbeat drops garbage entries and keeps the tick", () => {
  const s = normalizeHeartbeat({ tick: 7, jobs: { check: { at: "nope" }, report: { at: "2026-10-27T09:00:00Z", tick: "x" }, x: null } });
  assert.deepEqual(s, { tick: 7, jobs: { report: { at: "2026-10-27T09:00:00Z", tick: 0 } } });
  assert.deepEqual(normalizeHeartbeat([]), { tick: 0, jobs: {} });
});
