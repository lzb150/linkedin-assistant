// Shared language detection: "uk" (Ukrainian), "ru" (Russian) or "en" (default).
//
// Cyrillic has to carry a real share of the letters, not merely occur: the
// boards inject some of their own (DOU's raw title "Role в Company, Київ",
// Djinni's location line "Тільки віддалено · Україна · 2 роки досвіду"), and a
// single letter used to decide — every DOU and Djinni package got a Ukrainian
// cover letter, English-only JDs from English-speaking hiring managers included
// (29 of 29 on 2026-10-29). One Cyrillic letter in three is the bar: a Ukrainian
// posting full of English tooling names still clears it, a board's own
// location line against an English description (or a Djinni snippet) does not.
export function detectLang(text) {
  const t = (text || "").toLowerCase();
  const cyrillic = (t.match(/[Ѐ-ӿ]/g) || []).length;
  if (!cyrillic) return "en";
  const latin = (t.match(/[a-z]/g) || []).length;
  if (cyrillic * 2 < latin) return "en";
  if (/[іїєґ]/.test(t)) return "uk";   // Ukrainian-only letters
  if (/[ыэъё]/.test(t)) return "ru";   // Russian-only letters
  return "uk";                          // ambiguous Cyrillic -> lean UA
}
