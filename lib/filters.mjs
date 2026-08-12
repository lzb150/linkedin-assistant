// Global job filters applied in jobs.mjs after gathering, before dedup/scoring.

// Boards also list vacancies physically located abroad ("Краків, Польща",
// "за кордоном", "Tbilisi"). config.excludeLocation (top-level) lists
// case-insensitive substrings; a job whose location contains any of them is
// dropped across ALL sources.
export function filterByLocation(jobs, excludeLocation) {
  if (!excludeLocation?.length) return jobs;
  const patterns = excludeLocation.map((s) => String(s).toLowerCase());
  return jobs.filter((j) => {
    const loc = (j.location || "").toLowerCase();
    return !patterns.some((p) => loc.includes(p));
  });
}
