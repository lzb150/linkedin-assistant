// Shared language detection: "uk" (Ukrainian), "ru" (Russian) or "en" (default).
export function detectLang(text) {
  const t = (text || "").toLowerCase();
  if (!/[Ѐ-ӿ]/.test(t)) return "en";
  if (/[іїєґ]/.test(t)) return "uk";   // Ukrainian-only letters
  if (/[ыэъё]/.test(t)) return "ru";   // Russian-only letters
  return "uk";                          // ambiguous Cyrillic -> lean UA
}
