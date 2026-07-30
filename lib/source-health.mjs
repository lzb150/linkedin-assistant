// Scraper-health helpers: keep a short history of per-source found counts and
// flag any source that degraded well below its recent norm — not just to zero
// (a slow selector decay looks like 50 → 20 → 6, never a clean 0).
// No side effects — file load/save lives in jobs.mjs.

export const HISTORY_LEN = 10;
const DEGRADE_RATIO = 0.3; // alert when found < 30% of the recent median
const MIN_MEDIAN = 5;      // ignore sources whose norm is tiny (noise)

export function currentCounts(summary) {
  const out = {};
  for (const [source, b] of Object.entries(summary.sources)) {
    out[source] = b.found;
  }
  return out;
}

// The legacy file format was { source: <last run's count> } — migrate each
// number to a one-element history. Garbage in → empty history out.
export function normalizeHistory(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [src, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[src] = v.filter((n) => Number.isFinite(n));
    else if (Number.isFinite(v)) out[src] = [v];
  }
  return out;
}

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectDegradations(history, summary) {
  const out = [];
  for (const [source, b] of Object.entries(summary.sources)) {
    const med = median(history[source] || []);
    if (med >= MIN_MEDIAN && b.found < med * DEGRADE_RATIO) {
      out.push({ source, found: b.found, median: med });
    }
  }
  return out;
}

export function appendHistory(history, counts) {
  const out = { ...history };
  for (const [src, n] of Object.entries(counts)) {
    out[src] = [...(out[src] || []), n].slice(-HISTORY_LEN);
  }
  return out;
}

export function formatAlert(degradations) {
  return "⚠️ " + degradations
    .map((d) => `${d.source}: ${d.found} found (recent median ${d.median})`)
    .join("; ");
}
