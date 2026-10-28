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

// The keeper's key, then the keys of copies folded in by link, each with its
// own source: "same source" below is the copy's board, not the keeper's.
const copiesOf = (job) => [{ key: canonicalKey(job), source: job.source, url: job.url }, ...(job.mergedKeys || [])];

// A repost: the same vacancy from the same board under a NEW url while the
// package we have for it is closed (the board reported the old listing
// inactive). The seen store would bury it under its identity key — madappgang
// re-listed one job weekly for a month — so the gate lets it through to
// scoring again and the new package says "reposted ×N". Same url = the same
// listing (packaged); another board = a cross-source dup; neither is a repost.
// `closedFiles`: package files whose vacancy is closed (jobs.mjs reads
// job-state.json). → { file, url, reposts } of the newest closed prior, or null.
export function findRepost(job, { packageIndex, closedFiles }) {
  if (!closedFiles?.size) return null;
  const link = linkKey(job.url);
  const priors = copiesOf(job).flatMap((c) => (packageIndex.get(c.key) || []).filter((p) => isClosedPrior(p, c, link, closedFiles)));
  const best = priors.reduce(newer, null);
  return best ? { file: best.file, url: best.url, reposts: (Number(best.reposts) || 0) + 1 } : null;
}

// A closed package from the copy's own board, under another url and link.
function isClosedPrior(p, c, link, closedFiles) {
  return p.source === c.source && Boolean(p.url) && p.url !== c.url && linkKey(p.url) !== link && closedFiles.has(p.file);
}

// The later-generated of two packages; the first one on a tie.
const newer = (a, b) => (!a || (b.generated || "") > (a.generated || "") ? b : a);

// The first package of any copy that `pick(p, c)` accepts, or null.
function firstPackage(copies, packageIndex, pick) {
  for (const c of copies) {
    const hit = (packageIndex.get(c.key) || []).find((p) => pick(p, c));
    if (hit) return hit;
  }
  return null;
}

// A package we already hold for this vacancy → { kind: "packaged" | "dup", file }, or null.
function knownPackage(job, link, { packageIndex, packageLinks = new Map() }) {
  const copies = copiesOf(job);
  // Same source AND same url = the very package we already wrote (the seen
  // store lost it, the package did not). A different url from the same source
  // is still a distinct req.
  const same = firstPackage(copies, packageIndex, (p, c) => p.source === c.source && p.url && p.url === c.url);
  if (same) return { kind: "packaged", file: same.file };
  // The same link from another board is that package too, under a title the
  // canonical key cannot match; there is no new link to append.
  if (link && packageLinks.has(link)) return { kind: "packaged", file: packageLinks.get(link) };
  const existing = firstPackage(copies, packageIndex, (p, c) => p.source !== c.source);
  return existing ? { kind: "dup", file: existing.file } : null;
}

// Title exclusion, then the keyword score → { kind: "excluded", term } or { kind: "low" | "match", scored, retry }.
function scoreDecision(job, { excludedByTitle, minScore, requireRole, score = scoreMessage }) {
  const term = [job.title, ...(job.mergedTitles || [])].map(excludedByTitle).find(Boolean);
  if (term) return { kind: "excluded", term };
  const scored = score(job.text);
  // Cold applications: strict gate — high score AND an automation/SDET role match.
  const needRole = requireRole ? Boolean(scored.matchedRole) : true;
  // A card whose description failed to load (LinkedIn panel timeout, Djinni
  // detail fetch) scores on its title alone; marking it seen would bury it for
  // the 90-day TTL — whether the keyword gate or the LLM turns it down.
  const retry = (job.text || "").length < 300;
  return { kind: scored.score < minScore || !needRole ? "low" : "match", scored, retry };
}

// Decision for one job, in gate order:
//   { kind: "seen" }                         already in the seen store (either key spelling), or a copy dedupeJobs folded into it is
//   { kind: "packaged", file }               same source + url as an existing package, or the same link from any board
//   { kind: "dup", file }                    same vacancy packaged from another board (by its key or a folded copy's)
//   { kind: "excluded", term }               its title, or a folded copy's, hits excludeTitle
//   { kind: "low", scored, retry }           below minScore / no role; retry = no description yet
//   { kind: "match", scored, retry }         goes on to the LLM gate; retry = no description yet
// `considered` is true from "excluded" on: the job was new to this run.
// `repost` ({ file, url, reposts }) rides on excluded/low/match when the job
// re-lists a closed package (findRepost); the seen check is skipped for it,
// and jobs.mjs stamps `repost:<link>` so the same new url is not re-judged.
// `packageLinks`: linkKey → package file, for the reposts a canonical key misses.
// `score` is injectable so tests do not depend on the user's skills.json.
export function keywordGate(job, opts) {
  const { seen, packageIndex, closedFiles } = opts;
  const id = identityKey(job);
  const link = linkKey(job.url);
  // A re-listing of a closed package is judged afresh — once per new url.
  const repost = link && !seen.has(`repost:${link}`) ? findRepost(job, { packageIndex, closedFiles }) : null;
  // The keeper of a merged group may be the copy this run met first (a
  // channel's repost of a Djinni job judged last week): the vacancy is seen.
  if (!repost && [id, ...(job.mergedIds || [])].some((k) => seenEither(seen, k))) return { id, kind: "seen" };
  const known = knownPackage(job, link, opts);
  if (known) return { id, ...known };
  return { id, ...scoreDecision(job, opts), considered: true, ...(repost ? { repost } : {}) };
}
