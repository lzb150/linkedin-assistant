// Pure accumulator + formatters for the end-of-run digest in jobs.mjs.
// No side effects — fully unit testable without running scrapers.
//
//   newSummary()                    → { sources: {}, merged: 0, top: null }
//   recordFound(s, source, n)       raw count from a source fetch (pre-dedup)
//   recordOutcome(s, source, kind)  kind: excluded | seen | low | written (post-dedup)
//   recordMerged(s, n)              global cross-source duplicates collapsed
//   recordTop(s, score, label)      keep the max-scoring WRITTEN match
//   formatTable(s)                  multi-line string for the console
//   formatRunBanner(written, alerts) one-line banner string for notify(), "" when silent

const OUTCOMES = ["excluded", "seen", "low", "written"];

export function newSummary() {
  return { sources: {}, merged: 0, top: null };
}

function bucket(summary, source) {
  if (!summary.sources[source]) {
    summary.sources[source] = { found: 0, excluded: 0, seen: 0, low: 0, written: 0 };
  }
  return summary.sources[source];
}

export function recordFound(summary, source, n) {
  bucket(summary, source).found += n;
}

export function recordOutcome(summary, source, kind) {
  if (!OUTCOMES.includes(kind)) return;
  bucket(summary, source)[kind] += 1;
}

export function recordMerged(summary, n) {
  summary.merged += n;
}

export function recordTop(summary, score, label) {
  if (!summary.top || score > summary.top.score) {
    summary.top = { score, label };
  }
}

export function formatTable(summary) {
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `Run summary ${ts}`,
    "            found  excl  seen  low  NEW",
  ];
  for (const [source, b] of Object.entries(summary.sources)) {
    lines.push(
      "  " + source.padEnd(10) +
      String(b.found).padStart(4) + "  " +
      String(b.excluded).padStart(4) + "  " +
      String(b.seen).padStart(4) + "  " +
      String(b.low).padStart(4) + "  " +
      String(b.written).padStart(4)
    );
  }
  if (summary.merged > 0) {
    lines.push(`  merged ${summary.merged} cross-source duplicate(s)`);
  }
  if (summary.top) {
    lines.push(`  top score: ${summary.top.score} (${summary.top.label})`);
  }
  return lines.join("\n");
}

// One banner per run: breakage alerts first, then this run's new packages
// (strongest first, at most 3 labels). Empty when nothing happened — the hourly
// runs made ~30 "No new matches" banners a day; the dashboard timestamp and the
// weekly report are the heartbeat. LLM-scored entries outrank keyword-only ones
// (keyword-only means the LLM call failed).
export function formatRunBanner(written, alerts = []) {
  const lines = alerts.filter(Boolean);
  if (written?.length) {
    const strength = (w) => (w.llmScore != null ? 1000 + w.llmScore : w.score);
    const labels = [...written].sort((a, b) => strength(b) - strength(a)).slice(0, 3).map((w) => w.label);
    lines.push(`${written.length} new: ${labels.join(", ")}${written.length > 3 ? ", …" : ""}`);
  }
  return lines.join(" · ");
}
