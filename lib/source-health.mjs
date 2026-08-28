// Scraper-health helpers: keep a short history of per-source found counts and
// flag any source that degraded well below its recent norm — not just to zero
// (a slow selector decay looks like 50 → 20 → 6, never a clean 0).
// Known tradeoff: degraded counts enter the history too, so after ~5 broken
// runs the median converges to the broken value and the alert goes quiet —
// the same mechanism that re-baselines a legitimate "new normal".
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

const NEVER_RUNS = 5; // all-zero history at least this long → "never succeeded"

export function detectDegradations(history, summary) {
  const out = [];
  for (const [source, b] of Object.entries(summary.sources)) {
    const hist = history[source] || [];
    const med = median(hist);
    if (med >= MIN_MEDIAN && b.found < med * DEGRADE_RATIO) {
      out.push({ source, found: b.found, median: med });
    } else if (b.found === 0 && hist.length >= NEVER_RUNS && hist.every((n) => n === 0)) {
      // The median rule is blind to a source that never worked (median 0 is
      // "tiny norm"): a chronic 403 would stay silent forever without this.
      out.push({ source, found: 0, median: 0, reason: "never-succeeded", runs: hist.length });
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
    .map((d) => d.reason === "never-succeeded"
      ? `${d.source}: never returned results in ${d.runs} runs`
      : `${d.source}: ${d.found} found (recent median ${d.median})`)
    .join("; ");
}
