// The keyword gate jobs.mjs runs on every gathered vacancy, before any LLM
// call. Pure: it reads the seen store and the package index and returns a
// decision; jobs.mjs applies it (log line, summary outcome, seen stamp, alt link).
import { identityKey, canonicalKey } from "./dedup.mjs";
import { scoreMessage } from "./relevance.mjs";

// ponytail: keys stamped before 2026-08-28 had + and # stripped ("c++" → "c");
// accept that spelling too until they age out of the 90-day TTL (~2026-11-28).
export const legacyIdOf = (id) => id.replace(/[+#]+/g, " ").replace(/\s+/g, " ").trim();
export const seenEither = (seen, id) => seen.has(id) || seen.has(legacyIdOf(id));

// Seniority terms we never apply to, matched as whole words in the TITLE only,
// so a senior role whose description mentions "junior" is kept. Unicode-aware
// boundaries: an ASCII-only [^a-z0-9] class let "інтерн" match inside
// "інтернет-магазин". Returns title → the first matching term, or undefined.
export function titleExcluder(terms) {
  const res = terms.map((term) => ({
    term,
    re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu"),
  }));
  return (title) => res.find(({ re }) => re.test(title || ""))?.term;
}

// Decision for one job, in gate order:
//   { kind: "seen" }                         already in the seen store (either key spelling)
//   { kind: "packaged", file }               same source + url as an existing package
//   { kind: "dup", file }                    same vacancy packaged from another board
//   { kind: "excluded", term }               title hits excludeTitle
//   { kind: "low", scored, retry }           below minScore / no role; retry = no description yet
//   { kind: "match", scored, retry }         goes on to the LLM gate; retry = no description yet
// `considered` is true from "excluded" on: the job was new to this run.
// `score` is injectable so tests do not depend on the user's skills.json.
export function keywordGate(job, { seen, packageIndex, excludedByTitle, minScore, requireRole, score = scoreMessage }) {
  const id = identityKey(job);
  if (seenEither(seen, id)) return { id, kind: "seen" };
  const packaged = packageIndex.get(canonicalKey(job)) || [];
  // Same source AND same url = the very package we already wrote (the seen
  // store lost it, the package did not). A different url from the same source
  // is still a distinct req.
  const same = packaged.find((p) => p.source === job.source && p.url && p.url === job.url);
  if (same) return { id, kind: "packaged", file: same.file };
  const existing = packaged.find((p) => p.source !== job.source);
  if (existing) return { id, kind: "dup", file: existing.file };
  const term = excludedByTitle(job.title);
  if (term) return { id, kind: "excluded", term, considered: true };
  const scored = score(job.text);
  // Cold applications: strict gate — high score AND an automation/SDET role match.
  const needRole = requireRole ? Boolean(scored.matchedRole) : true;
  // A card whose description failed to load (LinkedIn panel timeout, Djinni
  // detail fetch) scores on its title alone; marking it seen would bury it for
  // the 90-day TTL — whether the keyword gate or the LLM turns it down.
  const retry = (job.text || "").length < 300;
  if (scored.score < minScore || !needRole) return { id, kind: "low", scored, retry, considered: true };
  return { id, kind: "match", scored, retry, considered: true };
}
