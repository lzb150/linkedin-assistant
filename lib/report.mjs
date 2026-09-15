// Pure aggregation for the weekly digest (report.mjs). No I/O — every input is
// already-parsed data, so this is unit-testable without touching the disk.
//
//   buildReport({ now, days, packages, logText, health })
//     → { text, notification }
//   countRunStats(logText, { since, until }) → { runs, considered, dropped, failed }
//
// The run-stats FILE these numbers now come from lives in run-stats.mjs — this
// module stays pure so it can be tested without touching the disk.

import { median } from "./source-health.mjs";   // same median as the degradation alert, so the report and the alert agree
import { localDay } from "./local-day.mjs";

// Not toLocaleDateString("sv-SE"): a small-ICU Node build has only en-US and
// silently returns "9/15/2026", which breaks every consumer of this string —
// in job-state it made copyFileSync fail on the slashes and disabled snapshots.
const day = (d) => localDay(new Date(d));                   // YYYY-MM-DD, local calendar day
const inWindow = (iso, since) => { const t = Date.parse(iso || ""); return Number.isFinite(t) && t >= since; };
const join = (pairs) => pairs.map(([k, v]) => `${k} ${v}`).join(" · ") || "—";

// Run counts and LLM outcomes exist only in the run logs (jobs.mjs logs them,
// writes nothing; jobs-seen.json keeps last-seen, not first-seen, so it cannot
// say what was new this week).
// ponytail: coupled to jobs.mjs log text; give jobs.mjs a counter file if this drifts.
// Anchored to the exact lines jobs.mjs writes — log() puts the ISO timestamp
// first, then console.log's separator space, then the message (skip/failed
// lines carry two leading spaces of their own, hence 3) — so a job title that
// happens to contain "Considered 500 new" or "· skip [...]" is not counted.
// `since` (ms) drops lines older than the reporting window. Without it the same
// digest mixed two windows: log FILES were picked by mtime, so the oldest file
// in range contributed every line it held, including runs from before the
// window, while package counts were filtered exactly. Omit it to count all.
export function countRunStats(logText, { since = null, until = null } = {}) {
  let runs = 0, considered = 0, dropped = 0, failed = 0;
  const inWindow = (stamp) => {
    if (since === null && until === null) return true;
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) return true;        // an unparsable stamp is kept, as before
    return (since === null || at >= since) && (until === null || at < until);
  };
  for (const m of logText.matchAll(/^(\S+) Done\. Considered (\d+) new, wrote/gm)) {
    if (!inWindow(m[1])) continue;
    runs++; considered += Number(m[2]);
  }
  for (const m of logText.matchAll(/^(\S+) {3}· skip \[\d+ \/ llm \d+\]/gm)) if (inWindow(m[1])) dropped++;
  for (const m of logText.matchAll(/^(\S+) {3}· llm failed for:/gm)) if (inWindow(m[1])) failed++;
  return { runs, considered, dropped, failed };
}

export function buildReport({ now = new Date(), days = 7, packages = [], logText = "", health = {}, runStats = [] }) {
  const since = now.getTime() - days * 86400000;
  // The stats file covers everything from its first entry onward; the log parser
  // fills in only the days before that, so switching to the file does not lose
  // the history written while it did not exist, and nothing is counted twice.
  // readRunStats attaches atMs, but this is an exported boundary: an entry
  // parsed straight from the file has only `at`, and NaN >= since is false, so
  // it would be dropped silently rather than counted.
  const stats = runStats
    .map((e) => ({ ...e, atMs: Number.isFinite(e.atMs) ? e.atMs : Date.parse(e.at) }))
    .filter((e) => Number.isFinite(e.atMs) && e.atMs >= since);
  const firstStat = stats.length ? Math.min(...stats.map((e) => e.atMs)) : null;
  const fromLog = countRunStats(logText, { since, until: firstStat });
  const run = {
    runs: fromLog.runs + stats.length,
    considered: fromLog.considered + stats.reduce((n, e) => n + (Number(e.considered) || 0), 0),
    dropped: fromLog.dropped + stats.reduce((n, e) => n + (Number(e.dropped) || 0), 0),
    failed: fromLog.failed + stats.reduce((n, e) => n + (Number(e.failed) || 0), 0),
  };

  const pk = packages.filter((p) => inWindow(p.generated, since));
  const bySource = {};
  for (const p of pk) bySource[p.source || "?"] = (bySource[p.source || "?"] || 0) + 1;
  const scored = pk.filter((p) => /^\d+$/.test(String(p.llm_score ?? "")));   // same gate as the dashboard badge
  const strong = scored.filter((p) => Number(p.llm_score) >= 70).length;
  const byModel = {};
  for (const p of scored) { const m = String(p.llm_model || "unknown"); byModel[m] = (byModel[m] || 0) + 1; }
  const models = Object.keys(byModel).length > 1 || (scored.length && !byModel.unknown) ? ` (${Object.entries(byModel).sort().map(([m, n]) => `${m} ${n}`).join(", ")})` : "";
  const top = scored.reduce((best, p) => (!best || Number(p.llm_score) > Number(best.llm_score) ? p : best), null);

  const yields = Object.entries(health).map(([src, runs]) => [src, median(runs || [])]);

  const text = [
    `Weekly job report — ${day(since)} → ${day(now)} (${days} days)`,
    `${run.runs} runs · ${run.considered} new vacancies considered · ${pk.length} packages written · LLM dropped ${run.dropped}, failed ${run.failed}`,
    `Packages by source: ${join(Object.entries(bySource).sort((a, b) => b[1] - a[1]))}`,
    `LLM scores: ${scored.length} scored${models}, ${strong} at ≥70 · top: ${top ? `${top.llm_score} ${top.title} @ ${top.company} (${top.source})` : "—"}`,
    `Source yield, median per run (last ${Math.max(0, ...Object.values(health).map((r) => (r || []).length))}): ${join(yields)}`,
  ].join("\n");

  const notification = `${pk.length} packages (LLM ≥70: ${strong}) · ${run.considered} new considered`;
  return { text, notification };
}
