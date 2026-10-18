// The keyword gate jobs.mjs runs on every gathered vacancy, before any LLM
// call. Pure: it reads the seen store and the package index and returns a
// decision; jobs.mjs applies it (log line, summary outcome, seen stamp, alt link).
import { identityKey, canonicalKey, linkKey } from "./dedup.mjs";
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
//   { kind: "seen" }                         already in the seen store (either key spelling), or a copy dedupeJobs folded into it is
//   { kind: "packaged", file }               same source + url as an existing package, or the same link from any board
//   { kind: "dup", file }                    same vacancy packaged from another board (by its key or a folded copy's)
//   { kind: "excluded", term }               its title, or a folded copy's, hits excludeTitle
//   { kind: "low", scored, retry }           below minScore / no role; retry = no description yet
//   { kind: "match", scored, retry }         goes on to the LLM gate; retry = no description yet
// `considered` is true from "excluded" on: the job was new to this run.
// `packageLinks`: linkKey → package file, for the reposts a canonical key misses.
// `score` is injectable so tests do not depend on the user's skills.json.
export function keywordGate(job, { seen, packageIndex, packageLinks = new Map(), excludedByTitle, minScore, requireRole, score = scoreMessage }) {
  const id = identityKey(job);
  // The keeper of a merged group may be the copy this run met first (a
  // channel's repost of a Djinni job judged last week): the vacancy is seen.
  if ([id, ...(job.mergedIds || [])].some((k) => seenEither(seen, k))) return { id, kind: "seen" };
  // The keeper's key, then the keys of copies folded in by link, each with its
  // own source: "same source" below is the copy's board, not the keeper's.
  const copies = [{ key: canonicalKey(job), source: job.source, url: job.url }, ...(job.mergedKeys || [])];
  const packagedFor = (c) => packageIndex.get(c.key) || [];
  // Same source AND same url = the very package we already wrote (the seen
  // store lost it, the package did not). A different url from the same source
  // is still a distinct req.
  for (const c of copies) {
    const same = packagedFor(c).find((p) => p.source === c.source && p.url && p.url === c.url);
    if (same) return { id, kind: "packaged", file: same.file };
  }
  // The same link from another board is that package too, under a title the
  // canonical key cannot match; there is no new link to append.
  const link = linkKey(job.url);
  if (link && packageLinks.has(link)) return { id, kind: "packaged", file: packageLinks.get(link) };
  for (const c of copies) {
    const existing = packagedFor(c).find((p) => p.source !== c.source);
    if (existing) return { id, kind: "dup", file: existing.file };
  }
  const term = [job.title, ...(job.mergedTitles || [])].map(excludedByTitle).find(Boolean);
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
