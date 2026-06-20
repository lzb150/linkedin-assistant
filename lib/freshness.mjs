// lib/freshness.mjs
// A job is "new since last visit" when it was generated after the stored
// lastVisit timestamp. With no baseline yet, nothing is flagged.
export function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO);
  const v = Date.parse(lastVisitISO);
  if (!Number.isFinite(g) || !Number.isFinite(v)) return false;
  return g > v;
}
