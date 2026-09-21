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
// "рок" needs a boundary: unanchored it matches Ма[рок]ко, and that turned a
// country segment into "nothing to judge" — the eligibility filter then passed
// a vacancy closed to the candidate. \b is ASCII-only in JS, so match the space.
const NOT_A_COUNTRY = /досвіду|(?:^|\s)рок|англійська|english|experience/i;
export const DEFAULT_CANDIDATE_COUNTRY = ["Ukraine", "Україна"];

// jobs.config.json is hand-edited, so its lists arrive unvalidated. A bare
// string where an array belongs used to throw inside .map()/.some() and take
// the whole run down (no packages, no dedup, no digest) instead of degrading
// the way every other reader here does (seen-store quarantine, job-state
// normalize, source-health normalizeHistory). An EMPTY array was worse: [] is
// truthy, so `config.candidateCountry || undefined` handed it straight through
// and the country gate rejected every Djinni vacancy but "Весь світ", while the
// LLM prompt read `?.[0]` -> undefined and still said Ukraine — two gates
// disagreeing on eligibility inside one run. Both lists normalize here so every
// caller, and both gates, see the same value.
export function candidateCountryList(v) {
  const list = toStringList(v);
  return list.length ? list : DEFAULT_CANDIDATE_COUNTRY;
}
export function excludeList(v) {
  return toStringList(v).map((s) => s.toLowerCase());
}
function toStringList(v) {
  return (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
}
// The numeric knobs arrive just as untyped. A comparison against a non-number
// is always false — `score < "abc"`, `0 < "abc"` — so a typo'd minScore did
// not fail, it switched the gate OFF and every keyword-passer got a package;
// `.slice(0, "abc")` gave every Djinni search a clean "ok (0 over 0 pages)".
// A number or numeric string is clamped to [lo, hi]; anything else → fallback.
export function numberIn(v, fallback, [lo, hi] = [-Infinity, Infinity]) {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
// numberIn for a named jobs.config.json knob: the same fallback, plus one line
// in the log the owner already reads when the value was ignored. The silent
// fallback is what kept a typo'd gate invisible in the first place.
export function knob(name, v, fallback, range, log = console.log) {
  if (v != null && Number.isNaN(numberIn(v, NaN, range))) log(`⚠ jobs.config.json: ${name} is ${JSON.stringify(v)}, not a number — using ${fallback}`);
  return numberIn(v, fallback, range);
}

export function djinniEligible(location, candidateCountry) {
  const parts = String(location || "").split(" · ").map((s) => s.trim()).filter(Boolean);
  let i = 0;
  while (i < parts.length && FORMAT.test(parts[i])) i++;
  const countries = parts[i];
  if (!countries || NOT_A_COUNTRY.test(countries)) return true;
  const c = countries.toLowerCase();
  return WORLDWIDE.test(c) || candidateCountryList(candidateCountry).some((name) => c.includes(name.toLowerCase()));
}
export function filterByLocation(jobs, excludeLocation, candidateCountry) {
  const patterns = excludeList(excludeLocation);
  const countries = candidateCountryList(candidateCountry);   // normalized once here, not once per Djinni job
  return jobs.filter((j) => {
    if (j.source === "djinni") return djinniEligible(j.location, countries);   // country check does not depend on the exclude list
    if (!patterns.length) return true;
    const loc = (j.location || "").toLowerCase();
    if (!patterns.some((p) => loc.includes(p))) return true;
    return j.source === "dou" && REMOTE.test(loc);
  });
}
