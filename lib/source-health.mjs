// Pure scraper-health helpers for the suspicious-zero alert in jobs.mjs.
// Compare this run's per-source found counts (from the run summary) against the
// previous run's stored counts and flag any source that dropped to zero.
// No side effects — file load/save lives in jobs.mjs.

export function currentCounts(summary) {
  const out = {};
  for (const [source, b] of Object.entries(summary.sources)) {
    out[source] = b.found;
  }
  return out;
}

export function detectRegressions(prev, summary) {
  const regressions = [];
  for (const [source, b] of Object.entries(summary.sources)) {
    if (b.found === 0 && (prev[source] ?? 0) > 0) {
      regressions.push({ source, was: prev[source] });
    }
  }
  return regressions;
}

export function mergeCounts(prev, current) {
  return { ...prev, ...current };
}

export function formatAlert(regressions) {
  return "⚠️ " + regressions
    .map((r) => `${r.source} returned 0 (was ${r.was})`)
    .join("; ");
}
