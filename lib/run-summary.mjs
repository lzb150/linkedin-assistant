// Pure accumulator + formatters for the end-of-run digest in jobs.mjs.
// No side effects — fully unit testable without running scrapers.
//
//   newSummary()                    → { sources: {}, merged: 0, top: null }
//   recordFound(s, source, n)       raw count from a source fetch (pre-dedup)
//   recordOutcome(s, source, kind)  kind: excluded | seen | low | written (post-dedup)
//   recordMerged(s, n)              global cross-source duplicates collapsed
//   recordTop(s, score, label)      keep the max-scoring WRITTEN match
//   formatTable(s)                  multi-line string for the console
//   formatNotification(s)           short one-line string for notify()

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

export function formatNotification(summary) {
  const written = Object.entries(summary.sources)
    .filter(([, b]) => b.written > 0)
    .map(([source, b]) => `${source} ${b.written} new`);
  if (written.length === 0) {
    const scanned = Object.values(summary.sources).reduce((a, b) => a + b.found, 0);
    return `No new matches · scanned ${scanned}`;
  }
  let line = written.join(", ");
  if (summary.top) line += ` · top ${summary.top.score}`;
  return line;
}

// Top-match banner: the strongest freshly-written packages. An LLM-scored
// entry is judged by the LLM verdict alone; keyword score decides otherwise.
export const TOP_LLM = 70;
export const TOP_KEYWORD = 40;

export function topMatches(written) {
  return (written || []).filter((w) =>
    w.llmScore != null ? w.llmScore >= TOP_LLM : w.score >= TOP_KEYWORD,
  );
}

export function formatTopMatches(matches) {
  if (!matches.length) return "";
  const head = matches.length === 1 ? "Strong match" : `${matches.length} strong matches`;
  const labels = matches.slice(0, 3).map((m) => m.label).join(", ");
  return `🔥 ${head}: ${labels}${matches.length > 3 ? ", …" : ""}`;
}
