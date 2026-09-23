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
// The digest parses the run logs with ^-anchored patterns, and those logs carry
// scraped board text (titles, companies, locations). oneLine() collapses that
// text upstream, but this parser is the thing being attacked, so it defends
// itself too: CR, U+2028 and U+2029 are line starts for /m just like \n, and a
// stray C0 character has no business in a log line either. Strip them (never
// \n — that is what separates the real lines) and require each counted line to
// begin with an ISO stamp the runner itself would have written.
// oxlint-disable-next-line no-control-regex
const FORGEABLE = /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g;
const STAMP = String.raw`(\d{4}-\d{2}-\d{2}T[\d:.]+Z)`;
// `tail` carries its own leading separator: the skip/failed lines are
// indented by exactly three spaces, the Done line by one.
const anchored = (tail) => new RegExp(`^${STAMP}${tail}`, "gm");

export function countRunStats(rawLogText, { since = null, until = null } = {}) {
  const logText = String(rawLogText ?? "").replace(FORGEABLE, " ");
  let runs = 0, considered = 0, written = 0, dropped = 0, failed = 0;
  const stampInWindow = (stamp) => {
    if (since === null && until === null) return true;
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) return true;        // an unparsable stamp is kept, as before
    return (since === null || at >= since) && (until === null || at < until);
  };
  for (const m of logText.matchAll(anchored(String.raw` Done\. Considered (\d+) new, wrote (\d+)`))) {
    if (!stampInWindow(m[1])) continue;
    runs++; considered += Number(m[2]); written += Number(m[3]);
  }
  for (const m of logText.matchAll(anchored(String.raw` {3}· skip \[\d+ \/ llm \d+\]`))) if (stampInWindow(m[1])) dropped++;
  for (const m of logText.matchAll(anchored(String.raw` {3}· llm failed for:`))) if (stampInWindow(m[1])) failed++;
  return { runs, considered, written, dropped, failed };
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
    // What the runs wrote, not what is still on disk: closed-check archives
    // closed packages after 14 days, so a longer window undercounted from `pk`.
    written: fromLog.written + stats.reduce((n, e) => n + (Number(e.written) || 0), 0),
    dropped: fromLog.dropped + stats.reduce((n, e) => n + (Number(e.dropped) || 0), 0),
    failed: fromLog.failed + stats.reduce((n, e) => n + (Number(e.failed) || 0), 0),
  };

  const pk = packages.filter((p) => inWindow(p.generated, since));
  const bySource = {};
  for (const p of pk) bySource[p.source || "?"] = (bySource[p.source || "?"] || 0) + 1;
  const scored = pk.filter((p) => /^\d+$/.test(String(p.llm_score ?? "")));   // same gate as the dashboard badge
  const byModel = {};
  for (const p of scored) { const m = String(p.llm_model || "unknown"); byModel[m] = (byModel[m] || 0) + 1; }
  const models = Object.keys(byModel).length > 1 || (scored.length && !byModel.unknown) ? ` (${Object.entries(byModel).sort().map(([m, n]) => `${m} ${n}`).join(", ")})` : "";
  const top = scored.reduce((best, p) => (!best || Number(p.llm_score) > Number(best.llm_score) ? p : best), null);

  const yields = Object.entries(health).map(([src, runs]) => [src, median(runs || [])]);

  const text = [
    `Weekly job report — ${day(since)} → ${day(now)} (${days} days)`,
    `${run.runs} runs · ${run.considered} new vacancies considered · ${run.written} packages written · LLM dropped ${run.dropped}, failed ${run.failed}`,
    `Packages by source: ${join(Object.entries(bySource).sort((a, b) => b[1] - a[1]))}`,
    `LLM scores: ${scored.length} scored${models} · top: ${top ? `${top.llm_score} ${top.title} @ ${top.company} (${top.source})` : "—"}`,
    `Source yield, median per run (last ${Math.max(0, ...Object.values(health).map((r) => (r || []).length))}): ${join(yields)}`,
  ].join("\n");

  // No "strong" count: jobs.mjs writes a scored package only when it clears
  // llm.minScore, so any bar at or below the gate counted every scored package.
  const notification = `${run.written} packages · ${run.considered} new considered`;
  return { text, notification };
}
