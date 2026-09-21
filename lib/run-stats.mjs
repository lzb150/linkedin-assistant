// The per-run counter file (run-stats.jsonl): jobs.mjs appends one line, the
// weekly digest reads it. Split out of report.mjs, which is pure aggregation.
import { appendFileSync, readFileSync } from "node:fs";
import { writeTextAtomic } from "./json-file.mjs";

// One JSON line per run, written by jobs.mjs. The digest used to rebuild these
// four numbers by regex over jobs.mjs's own log lines, anchored to their exact
// wording — rewording one silently zeroed the report, which already happened at
// the run.sh rename. Appending must never break a run that has otherwise
// finished, so a failure here is swallowed by the caller's own try.
// Hourly runs forever means this file only ever grew, and the digest reads all
// of it every week. Nothing else here is unbounded — jobs-seen.json has a TTL,
// logs/ is pruned at 30 days, archived packages at 180 — so keep the last
// MAX_LINES (about 5 weeks of hourly runs, well past the 7-day digest window)
// and drop the rest on the way past. Rewritten atomically so a trim that dies
// half-way cannot leave a truncated file behind.
export const MAX_LINES = 900;
export function appendRunStat(file, { considered = 0, written = 0, dropped = 0, failed = 0 } = {}, now = new Date(), { maxLines = MAX_LINES, warn = console.warn } = {}) {
  const line = JSON.stringify({ at: now.toISOString(), considered, written, dropped, failed }) + "\n";
  // Two try blocks, not one. Swallowing the APPEND is deliberate — the run's
  // work is already on disk and a missing stat line is not worth failing for.
  // Swallowing the TRIM as well meant that if it ever failed (ENOSPC, EACCES)
  // the file grew past maxLines forever with nothing to notice it by — and the
  // cap is the one thing this module promises.
  try {
    appendFileSync(file, line);
  } catch { return; }
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > maxLines) writeTextAtomic(file, lines.slice(-maxLines).join("\n") + "\n");
  } catch (e) {
    warn(`run-stats: could not trim ${file} (${e.message}) — it will keep growing past ${maxLines} lines`);
  }
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
