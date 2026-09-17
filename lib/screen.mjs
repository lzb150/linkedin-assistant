// Everything jobs.mjs decides about one gathered vacancy before it is worth an
// LLM call. It used to be ~50 lines inlined in the run script, which meant the
// only test that could reach these rules was the whole-process e2e: a fake RSS
// feed, a fake `claude` and a fake notifier, for what are pure decisions.
//
// Both entry points share one set of rules on purpose. `known` is the cheap
// pre-flight the scrapers ask before paying for a detail page (LinkedIn's click
// + 1.8 s, Djinni's fetch — most of every run), `screen` the full verdict for a
// job that was gathered anyway. When those two disagreed, a job skipped as
// "known" could still arrive at the scoring loop as new, or vice versa.
//
// Pure: it decides, it never writes. The caller stamps the seen store, appends
// the alt link and logs, so a verdict can be asserted without a filesystem.

import { identityKey, legacyIdentityKey, canonicalKey } from "./dedup.mjs";
import { titleExcluder } from "./filters.mjs";
import { scoreMessage } from "./relevance.mjs";

// A LinkedIn card whose description panel timed out scores on its title alone.
// Marking it seen would bury it for the whole 90-day TTL, so a short text means
// "retry next run" instead.
const MIN_DESCRIPTION = 300;

/**
 * @param config    jobs.config.json (excludeTitle, minScore, requireRole, per-source minScore)
 * @param seen      seen store (only `.has` is used — screening never writes)
 * @param packages  canonicalKey -> { file, source } index of packages already on disk
 */
export function createScreener({ config = {}, seen, packages = new Map() } = {}) {
  const excludedByTitle = titleExcluder(config.excludeTitle);
  // Either key spelling counts as seen; the legacy one is dropped when the last
  // pre-2026-08-28 entry expires.
  const isSeen = (id) => seen.has(id) || seen.has(legacyIdentityKey(id));

  return {
    /** Cheap pre-flight for the scrapers: true → do not open the detail page. */
    known(job) {
      return isSeen(identityKey(job)) || Boolean(excludedByTitle(job.title));
    },

    /**
     * Full verdict. Always carries `id` (the seen-store key), `markSeen` (may
     * the caller stamp it?) and `considered` (does it count as new work?).
     *
     * seen      — already stamped this TTL; re-stamp so the window is "last
     *             seen", not "first seen"
     * duplicate — the same vacancy already has a package from ANOTHER source:
     *             `file` gets the alt link, no second package
     * excluded  — `term` of config.excludeTitle matched the title
     * low       — below the keyword gate; `retry` means the description never
     *             loaded, so do NOT stamp it
     * match     — passes the keyword gate, hand it to the LLM gate
     */
    screen(job) {
      const id = identityKey(job);
      if (isSeen(id)) return { action: "seen", id, markSeen: true, considered: false };

      // Cross-run dedup: the same vacancy resurfacing on another board must not
      // spawn a second package. Same source = a distinct req, and allowed.
      const existing = packages.get(canonicalKey(job));
      if (existing && existing.source !== job.source) {
        return { action: "duplicate", id, file: existing.file, markSeen: true, considered: false };
      }

      const term = excludedByTitle(job.title);
      if (term) return { action: "excluded", id, term, markSeen: true, considered: true };

      const scored = scoreMessage(job.text);
      // Cold applications: strict gate — high score AND an automation/SDET role
      // match. A source may set its own minScore; it overrides the global.
      const minScore = config[job.source]?.minScore ?? config.minScore ?? 25;
      const roleOk = config.requireRole ? Boolean(scored.matchedRole) : true;
      if (scored.score < minScore || !roleOk) {
        const retry = (job.text || "").length < MIN_DESCRIPTION;
        return { action: "low", id, scored, retry, markSeen: !retry, considered: true };
      }
      return { action: "match", id, scored, markSeen: false, considered: true };
    },
  };
}
