// Global job filters applied in jobs.mjs after gathering, before dedup/scoring.

// Boards also list vacancies physically located abroad ("Краків, Польща",
// "за кордоном", "Tbilisi"). config.excludeLocation (top-level) lists
// case-insensitive substrings; a job whose location contains any of them is
// dropped across ALL sources — except DOU listings that are remote: DOU lists
// every OFFICE plus "віддалено" ("Київ, Варшава (Польща), віддалено"), and 8
// on-profile remote vacancies per run were dropped for a foreign office.
//
// Djinni is different and gets its own rule: its metadata line is
// "<format> · <countries> · N років досвіду · …", and <countries> is where
// candidates must LIVE — "Тільки віддалено · Канада, Польща, Сербія" is remote
// but closed to Ukraine (844082 @ PAR Retail got a package on 2026-09-11).
// Observed values: "Україна", "Україна (Київ)", "Країни Європи та Україна",
// "Весь світ" (eligible); "Польща", "Країни ЄС", foreign lists (not). No
// country segment at all (e.g. "Part-time · 3 роки досвіду") → nothing to
// judge, keep.
// `candidateCountry` (jobs.config.json) lists every spelling of the candidate's
// country; the whole-world markers are board wording and stay generic.
const REMOTE = /віддалено|дистанційно|remote/i;
const WORLDWIDE = /весь світ|worldwide|будь-яка країна|any country/i;
const FORMAT = /віддалено|офіс|гібрид|part-time|full-time|remote|office|hybrid/i;
const NOT_A_COUNTRY = /досвіду|рок|англійська|english|experience/i;
const DEFAULT_CANDIDATE_COUNTRY = ["Ukraine", "Україна"];
export function djinniEligible(location, candidateCountry = DEFAULT_CANDIDATE_COUNTRY) {
  const parts = String(location || "").split(" · ").map((s) => s.trim()).filter(Boolean);
  let i = 0;
  while (i < parts.length && FORMAT.test(parts[i])) i++;
  const countries = parts[i];
  if (!countries || NOT_A_COUNTRY.test(countries)) return true;
  const c = countries.toLowerCase();
  return WORLDWIDE.test(c) || candidateCountry.some((name) => c.includes(String(name).toLowerCase()));
}
export function filterByLocation(jobs, excludeLocation, candidateCountry = DEFAULT_CANDIDATE_COUNTRY) {
  if (!excludeLocation?.length) return jobs;
  const patterns = excludeLocation.map((s) => String(s).toLowerCase());
  return jobs.filter((j) => {
    if (j.source === "djinni") return djinniEligible(j.location, candidateCountry);
    const loc = (j.location || "").toLowerCase();
    if (!patterns.some((p) => loc.includes(p))) return true;
    return j.source === "dou" && REMOTE.test(loc);
  });
}
