// Cross-source job de-duplication. Pure, dependency-free, no network.
// The same vacancy posted on DOU/Djinni/Jooble/LinkedIn arrives with a
// different URL per board; we collapse those into one record using an
// identity key built from the normalized company + title.

// Company legal-form suffixes to drop so "SoftServe LLC" == "SoftServe".
// Latin and Cyrillic forms; Cyrillic ones (ТОВ/ООО) usually lead the name.
const COMPANY_SUFFIXES = [
  "llc", "inc", "ltd", "limited", "gmbh", "corp", "corporation",
  "co", "company", "group", "llp", "plc", "ag", "sa", "srl", "bv",
  "ооо", "тов", "пп", "фоп",
];

function basicNormalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompany(s) {
  let t = basicNormalize(s);
  // Drop legal-form tokens wherever they appear (lead or trail).
  const tokens = t.split(" ").filter((tok) => tok && !COMPANY_SUFFIXES.includes(tok));
  return tokens.join(" ");
}

export function normalizeTitle(s) {
  // Intentionally light: case/punctuation/whitespace only. A parenthetical
  // qualifier like "(Playwright)" survives as the token "playwright", so
  // distinct roles at the same company do not merge.
  return basicNormalize(s);
}

export function identityKey(job) {
  return `${normalizeCompany(job.company)}::${normalizeTitle(job.title)}`;
}

/**
 * Collapse duplicate jobs by identity key.
 * Keeps the record with the longest `text` (richest description → most
 * accurate scoring) and attaches `altLinks: [{ source, url }]` for every
 * dropped duplicate (excluding the kept record itself).
 * @returns { deduped: Job[], mergedCount: number }
 */
export function dedupeJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = identityKey(job);
    const g = groups.get(key);
    if (g) g.push(job);
    else groups.set(key, [job]);
  }

  const deduped = [];
  let mergedCount = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    // Keep the record with the longest text.
    const keep = group.reduce((a, b) => ((b.text || "").length > (a.text || "").length ? b : a));
    keep.altLinks = group
      .filter((j) => j !== keep)
      .map((j) => ({ source: j.source, url: j.url }));
    mergedCount += group.length - 1;
    deduped.push(keep);
  }

  return { deduped, mergedCount };
}
