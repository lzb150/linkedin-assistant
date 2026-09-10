// Global job filters applied in jobs.mjs after gathering, before dedup/scoring.

// Boards also list vacancies physically located abroad ("Краків, Польща",
// "за кордоном", "Tbilisi"). config.excludeLocation (top-level) lists
// case-insensitive substrings; a job whose location contains any of them is
// dropped across ALL sources — unless the location also says remote: DOU lists
// every office plus "віддалено" ("Київ, Варшава (Польща), віддалено"), and
// 8 on-profile remote vacancies were being dropped per run for a foreign office.
const REMOTE = /віддалено|дистанційно|remote/i;
export function filterByLocation(jobs, excludeLocation) {
  if (!excludeLocation?.length) return jobs;
  const patterns = excludeLocation.map((s) => String(s).toLowerCase());
  return jobs.filter((j) => {
    const loc = (j.location || "").toLowerCase();
    return REMOTE.test(loc) || !patterns.some((p) => loc.includes(p));
  });
}
