// The per-run counter file (run-stats.jsonl): jobs.mjs appends one line, the
// weekly digest reads it. Split out of report.mjs, which is pure aggregation.
import { appendFileSync, readFileSync } from "node:fs";

// One JSON line per run, written by jobs.mjs. The digest used to rebuild these
// four numbers by regex over jobs.mjs's own log lines, anchored to their exact
// wording — rewording one silently zeroed the report, which already happened at
// the run.sh rename. Appending must never break a run that has otherwise
// finished, so a failure here is swallowed by the caller's own try.
export function appendRunStat(file, { considered = 0, written = 0, dropped = 0, failed = 0 } = {}, now = new Date()) {
  try {
    appendFileSync(file, JSON.stringify({ at: now.toISOString(), considered, written, dropped, failed }) + "\n");
  } catch { /* the run's work is already on disk; a missing stat line is not worth failing for */ }
}

// Entries inside the window. A malformed line (a crash mid-append) is skipped
// rather than throwing the whole digest away.
export function readRunStats(file, { since = null } = {}) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const at = Date.parse(e?.at);
      if (!Number.isFinite(at)) continue;
      if (since === null || at >= since) out.push({ ...e, atMs: at });
    } catch { /* skip */ }
  }
  return out;
}
