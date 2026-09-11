// Global job filters applied in jobs.mjs after gathering, before dedup/scoring.

// Boards also list vacancies physically located abroad ("Краків, Польща",
// "за кордоном", "Tbilisi"). config.excludeLocation (top-level) lists
// case-insensitive substrings; a job whose location contains any of them is
// dropped across ALL sources, with two exceptions:
// - a location naming Ukraine is kept whatever else it lists ("Країни Європи
//   та Україна", "Канада, Польща, Україна") — the candidate is eligible;
// - DOU lists every OFFICE plus "віддалено" ("Київ, Варшава (Польща),
//   віддалено"): remote wins there (8 on-profile remote vacancies per run were
//   dropped for a foreign office). NOT on Djinni: its "Тільки віддалено ·
//   Канада, Польща, Сербія" names the countries candidates must live in, so a
//   foreign-only list is a real exclusion even when the job is remote
//   (844082 @ PAR Retail slipped through on 2026-09-11 under a source-blind rule).
const REMOTE = /віддалено|дистанційно|remote/i;
const UKRAINE = /україна|ukraine/i;
export function filterByLocation(jobs, excludeLocation) {
  if (!excludeLocation?.length) return jobs;
  const patterns = excludeLocation.map((s) => String(s).toLowerCase());
  return jobs.filter((j) => {
    const loc = (j.location || "").toLowerCase();
    if (!patterns.some((p) => loc.includes(p))) return true;
    if (UKRAINE.test(loc)) return true;
    return j.source === "dou" && REMOTE.test(loc);
  });
}
