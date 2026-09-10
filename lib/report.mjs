// Pure aggregation for the weekly digest (report.mjs). No I/O — every input is
// already-parsed data, so this is unit-testable without touching the disk.
//
//   buildReport({ now, days, packages, logText, health })
//     → { text, notification }
//   countRunStats(logText) → { runs, considered, dropped, failed }

const day = (d) => new Date(d).toLocaleDateString("sv-SE"); // YYYY-MM-DD, local calendar day
const inWindow = (iso, since) => { const t = Date.parse(iso || ""); return Number.isFinite(t) && t >= since; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const join = (pairs) => pairs.map(([k, v]) => `${k} ${v}`).join(" · ") || "—";

// Run counts and LLM outcomes exist only in the run logs (jobs.mjs logs them,
// writes nothing; jobs-seen.json keeps last-seen, not first-seen, so it cannot
// say what was new this week).
// ponytail: coupled to jobs.mjs log text; give jobs.mjs a counter file if this drifts.
export function countRunStats(logText) {
  let runs = 0, considered = 0;
  for (const m of logText.matchAll(/Considered (\d+) new/g)) { runs++; considered += Number(m[1]); }
  const dropped = (logText.match(/· skip \[\d+ \/ llm \d+\]/g) || []).length;
  const failed = (logText.match(/· llm failed for:/g) || []).length;
  return { runs, considered, dropped, failed };
}

export function buildReport({ now = new Date(), days = 7, packages = [], logText = "", health = {} }) {
  const since = now.getTime() - days * 86400000;
  const run = countRunStats(logText);

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
