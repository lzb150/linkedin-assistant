// Last-success heartbeat for the launchd jobs. Each script stamps its own
// clean finish in last-success.json; every stamp also looks at the others
// and raises an alert for a job that has stopped finishing.
//
// Why a global tick and not just the clock: this Mac sleeps on battery, and a
// job that merely slept through the night is not dead. A job is stale only when
// it is old by the clock AND enough other jobs finished meanwhile — proof the
// machine was awake and launchd was firing. The tick counts every stamp by any
// job, so "runs since" is awake time measured in completed runs.
//
// One alert per outage: alertedAt is set when we shout and compared with the
// job's own stamp, so a job that is still down re-alerts once a day, and a job
// that recovered (its stamp is newer than alertedAt) starts clean.
//
// Jobs are discovered from the file: a job that never stamped is not expected
// (no Djinni account → no djinni-check alerts). Thresholds by job name below;
// unknown names get the hourly defaults.
import { readJson, writeJsonAtomic } from "./json-file.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// hours: how old by the clock; runs: other stamps since (≈ 3 per awake hour).
export const LIMITS = {
  "check":          { hours: 12, runs: 12 },   // LinkedIn inbox, hourly
  "djinni-check":   { hours: 12, runs: 12 },   // Djinni inbox, hourly
  "jobs-dou":       { hours: 12, runs: 12 },   // DOU/Djinni/Himalayas/Telegram discovery, hourly
  "jobs-linkedin":  { hours: 30, runs: 30 },   // LinkedIn discovery, 3-hourly, often deferred overnight
  "closed-check":   { hours: 72, runs: 60 },   // daily
  "report":         { hours: 9 * 24, runs: 150 }, // weekly
  "backup":         { hours: 48, runs: 60 },   // nightly archive (backup.mjs)
};
const DEFAULT_LIMIT = { hours: 12, runs: 12 };
const REALERT_MS = DAY;

export function normalizeHeartbeat(raw) {
  const tick = Number.isFinite(raw?.tick) ? raw.tick : 0;
  const jobs = {};
  if (raw && typeof raw.jobs === "object" && !Array.isArray(raw.jobs)) {
    for (const [name, j] of Object.entries(raw.jobs)) {
      const job = jobStamp(j);
      if (job) jobs[name] = job;
    }
  }
  return { tick, jobs };
}

// One job's entry as read from disk; null when it has no parsable `at`.
function jobStamp(j) {
  if (!j || typeof j !== "object" || !Number.isFinite(Date.parse(j.at))) return null;
  return { at: j.at, tick: Number.isFinite(j.tick) ? j.tick : 0, ...(j.alertedAt ? { alertedAt: j.alertedAt } : {}) };
}

// Pure: the state after `job` finished cleanly at `now`.
export function stamp(state, job, now = new Date()) {
  const tick = state.tick + 1;
  const prev = state.jobs[job] || {};
  return { tick, jobs: { ...state.jobs, [job]: { ...prev, at: now.toISOString(), tick } } };
}

// Pure: jobs other than `self` that are both old by the clock and have been
// out-run by `limits.runs` other stamps — and have not been alerted on since
// their last success (or were, but a day ago).
export function staleJobs(state, { self, now = new Date(), limits = LIMITS } = {}) {
  const out = [];
  for (const [name, j] of Object.entries(state.jobs)) {
    if (name === self) continue;
    const lim = limits[name] || DEFAULT_LIMIT;
    const ageMs = now - Date.parse(j.at);
    const runsSince = state.tick - j.tick;
    if (ageMs < lim.hours * HOUR || runsSince < lim.runs) continue;
    if (alertedThisOutage(j, now)) continue;
    out.push({ job: name, hours: Math.round(ageMs / HOUR), runs: runsSince });
  }
  return out;
}

// Already alerted on since its last success, less than a day ago.
function alertedThisOutage(j, now) {
  const alertedAt = Date.parse(j.alertedAt || "");
  return Number.isFinite(alertedAt) && alertedAt > Date.parse(j.at) && now - alertedAt < REALERT_MS;
}

export function formatStale(stale) {
  return "⚠️ " + stale.map((s) => `${s.job}: no successful run for ${s.hours} h while ${s.runs} other runs finished — is its launchd job loaded?`).join("; ");
}

// Stamp `job`, then alert (once per outage) for every other job that went
// quiet. File errors are logged, never thrown: a heartbeat must not fail the
// run it is reporting on.
export function heartbeat(file, job, { now = new Date(), log = () => {}, alert = () => {}, limits = LIMITS } = {}) {
  let state;
  try { state = normalizeHeartbeat(readJson(file, {})); }
  catch (e) {
    // A torn file is not worth a dead watchdog: start a fresh history (the
    // first alerts come back after `runs` stamps) rather than skip forever.
    log(`⚠ ${file} unreadable (${e.message}) — heartbeat history reset`);
    state = { tick: 0, jobs: {} };
  }
  let next = stamp(state, job, now);
  const stale = staleJobs(next, { self: job, now, limits });
  for (const s of stale) next.jobs[s.job] = { ...next.jobs[s.job], alertedAt: now.toISOString() };
  try { writeJsonAtomic(file, next, 2); }
  catch (e) { log(`⚠ ${file} not written (${e.message})`); }
  if (stale.length) alert(formatStale(stale));
  return stale;
}
