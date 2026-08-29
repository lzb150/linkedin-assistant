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
  // NFC first: the class below strips combining marks, so a decomposed "й"
  // would otherwise split into "и" + space. Keep + and #: C++ / C# / C differ.
  return (s || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#\s]+/gu, " ") // strip punctuation/symbols («»“”’®™ …)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompany(s) {
  // "—" is the empty-company placeholder written to package frontmatter;
  // treat it as empty so package-index keys match live jobs.
  let t = basicNormalize(s === "—" ? "" : s);
  // Drop legal-form tokens wherever they appear (lead or trail).
  const tokens = t.split(" ").filter((tok) => tok && !COMPANY_SUFFIXES.includes(tok));
  // A name made only of legal-form tokens ("Group", "Group LLC") is still a
  // name: keep its FIRST token so "Group" and "Group LLC" normalize alike.
  // (Order-sensitive by design: "LLC Group" → "llc"; rare enough to accept.)
  return tokens.length ? tokens.join(" ") : t.split(" ").filter(Boolean).slice(0, 1).join("");
}

function urlKey(url) {
  try { const u = new URL(url); return u.host + u.pathname; } catch { return String(url || ""); }
}

// Company component shared by BOTH keys: a blank company would make every
// "QA Engineer" from unrelated employers one identity (seen-set, package
// index, dashboard collapse), so scope it to the posting's own host+path.
function companyKey(job) {
  return normalizeCompany(job.company) || urlKey(job.url);
}

export function normalizeTitle(s) {
  // Intentionally light: case/punctuation/whitespace only. A parenthetical
  // qualifier like "(Playwright)" survives as the token "playwright", so
  // distinct roles at the same company do not merge.
  return basicNormalize(s);
}

export function identityKey(job) {
  return `${companyKey(job)}::${normalizeTitle(job.title)}`;
}

// Title-token aliases: boards reword the same role ("AQA Engineer" vs
// "Automation QA Engineer"); each alias expands to its canonical tokens.
const TITLE_ALIASES = { aqa: ["automation", "qa"] };

// Looser identity for cross-source matching: req-number tokens dropped
// (Ciklum's "(3282)"), aliases expanded, token order ignored. Seniority tokens
// survive, so Lead vs Senior never merges. identityKey stays the strict form
// used by the seen set, the dashboard collapse and prune-applications.mjs.
export function canonicalKey(job) {
  const tokens = normalizeTitle(job.title)
    .split(" ")
    .filter((t) => t && !/^#?\d{3,}$/.test(t)) // req IDs are 3+ digits, "(3282)" or "(#3282)"; "Engineer 2" keeps its level
    .flatMap((t) => TITLE_ALIASES[t] || [t]);
  return `${companyKey(job)}::${[...new Set(tokens)].sort().join(" ")}`;
}

/**
 * Collapse duplicate jobs by canonical key.
 * Same-source records with the same key stay separate — the board itself
 * distinguishes them (distinct req numbers = distinct positions). Records from
 * other sources fold into the kept ones as `altLinks: [{ source, url }]`,
 * round-robin. The group's longest `text` is kept on the richest keeper so
 * scoring never degrades.
 * @returns { deduped: Job[], mergedCount: number }
 */
export function dedupeJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = canonicalKey(job); // blank companies are url-scoped inside companyKey
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
    const longest = group.reduce((a, b) => ((b.text || "").length > (a.text || "").length ? b : a));
    // Keepers = every record of the source with the most entries in the group
    // (tie broken toward the source holding the longest text).
    const bySource = new Map();
    for (const j of group) {
      const list = bySource.get(j.source) || [];
      list.push(j);
      bySource.set(j.source, list);
    }
    const maxCount = Math.max(...[...bySource.values()].map((l) => l.length));
    const tied = [...bySource.entries()].filter(([, l]) => l.length === maxCount);
    const keepers = (tied.find(([s]) => s === longest.source) || tied[0])[1];
    const others = group.filter((j) => !keepers.includes(j));
    others.forEach((j, i) => {
      const k = keepers[i % keepers.length];
      (k.altLinks = k.altLinks || []).push({ source: j.source, url: j.url });
    });
    // Richest description wins for scoring.
    const richest = keepers.reduce((a, b) => ((b.text || "").length > (a.text || "").length ? b : a));
    if ((longest.text || "").length > (richest.text || "").length) richest.text = longest.text;
    mergedCount += others.length;
    deduped.push(...keepers);
  }

  return { deduped, mergedCount };
}
