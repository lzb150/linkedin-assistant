// Local, dependency-free relevance scoring.
// Compares a LinkedIn message (ideally containing a job description) against
// your skill profile in skills.json. No network, no API key, nothing leaves the machine.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(readFileSync(join(__dir, "..", "skills.json"), "utf8"));

// The same few hundred profile patterns are compiled for every job scored;
// cache by source string so a run compiles each once.
const RE_CACHE = new Map();
function cachedRe(src) {
  let re = RE_CACHE.get(src);
  if (!re) RE_CACHE.set(src, (re = new RegExp(src, "i")));
  return re;
}

// Match a multi-word phrase as a whole-word-ish substring (case-insensitive).
function mentions(haystack, phrase) {
  // escape regex special chars, allow flexible whitespace between words
  const pat = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return cachedRe(`(^|[^a-z0-9+#])${pat}([^a-z0-9+#]|$)`).test(haystack);
}

// Cyrillic letters (incl. Ukrainian і ї є ґ). Used for detection and stemming.
const CYR = "\\u0400-\\u04FF";
const CYR_RE = new RegExp(`[${CYR}]`);
function hasCyrillic(s) { return CYR_RE.test(s); }

// Common UA/RU inflectional endings (≤3 chars), longest first. Conservative: we
// strip at most one ending and keep stems ≥4 Cyrillic chars, so derivational
// roots survive (e.g. "досвід" untouched; "автоматизація" -> "автоматизац").
const CYR_ENDINGS = [
  "ого", "ому", "ами", "ями", "ння", "ень", "его", "ему", "ими",
  "ія", "ня", "ть", "ти", "ах", "ях", "ам", "ям", "ою", "ею",
  "ів", "ий", "ый", "ій", "их", "ые", "ом", "ой",
  "а", "я", "и", "і", "ї", "е", "є", "о", "у", "ю", "ы", "й", "ь",
];
const MIN_STEM = 4;

// Strip one inflectional ending from a Cyrillic word; Latin words pass through.
export function stemCyrillic(word) {
  const w = (word || "").toLowerCase();
  if (!hasCyrillic(w)) return w;
  for (const end of CYR_ENDINGS) {
    if (w.length - end.length >= MIN_STEM && w.endsWith(end)) {
      return w.slice(0, -end.length);
    }
  }
  return w;
}

// Stem-tolerant match for Cyrillic phrases: each Cyrillic word becomes its stem
// plus a trailing Cyrillic wildcard, so any case form in the text matches. A
// phrase with no Cyrillic falls back to the exact `mentions()` matcher, leaving
// English/Latin behaviour (word boundaries, "c#", "ci/cd") unchanged.
export function mentionsStem(haystack, phrase) {
  if (!hasCyrillic(phrase)) return mentions(haystack, phrase);
  const body = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean)
    .map((w) => {
      const esc = stemCyrillic(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return hasCyrillic(w) ? `${esc}[${CYR}]*` : esc;
    })
    .join("\\s+");
  return cachedRe(`(^|[^a-z0-9${CYR}+#])(?:${body})(?![a-z0-9${CYR}+#])`).test(haystack);
}

// True if a concept matches the text via its key or any of its synonyms.
// Ensures a concept's weight is added at most once.
function conceptMatches(hay, key, synonyms) {
  if (mentionsStem(hay, key)) return true;
  if (Array.isArray(synonyms)) {
    for (const s of synonyms) if (mentionsStem(hay, s)) return true;
  }
  return false;
}

/**
 * Score one message's text against a skill profile (defaults to the live
 * skills.json — pass a fixture in tests so they don't depend on user config).
 * @returns { score, matchedSkills, matchedRole, penalties, verdict }
 *   verdict: "relevant" | "maybe" | "ignore"
 */
export function scoreMessage(text, p = profile) {
  const hay = (text || "").toLowerCase();
  let score = 0;
  const matchedSkills = [];
  const penalties = [];

  // Role match is a strong signal — counts once, weighted heavily.
  let matchedRole = null;
  for (const role of p.roles || []) {
    if (mentionsStem(hay, role)) {
      matchedRole = role;
      score += 6;
      break;
    }
  }

  // Skill matches (each concept counts once — key OR any synonym). Only the
  // top `maxSkills` weights count toward the score, so keyword-stuffed
  // postings can't outscore real matches; matchedSkills still lists every hit.
  const matchedWeights = [];
  for (const [skill, weight] of Object.entries(p.skills || {})) {
    if (conceptMatches(hay, skill, p.synonyms?.[skill])) {
      matchedWeights.push(weight);
      matchedSkills.push(skill);
    }
  }
  score += matchedWeights
    .sort((a, b) => b - a)
    .slice(0, p.maxSkills ?? 8)
    .reduce((a, w) => a + w, 0);

  // Anti-keywords reduce the score (English today; routed through the same
  // matcher so a Cyrillic anti-keyword would also work if added later).
  for (const [bad, weight] of Object.entries(p.antiKeywords || {})) {
    if (mentionsStem(hay, bad)) {
      score += weight; // weight is negative
      penalties.push(bad);
    }
  }

  const t = p.thresholds || { relevant: 8, maybe: 4 };
  let verdict = "ignore";
  if (score >= t.relevant) verdict = "relevant";
  else if (score >= t.maybe) verdict = "maybe";

  return { score, matchedSkills, matchedRole, penalties, verdict };
}

/**
 * Decide whether a message even looks like a recruiter/job message worth scoring.
 * Cheap pre-filter so we don't draft replies to "Congrats on your work anniversary".
 */
export function looksLikeJobMessage(text) {
  const hay = (text || "").toLowerCase();
  const signals = [
    "role", "position", "opportunity", "vacancy", "opening", "hiring",
    "job description", "we are looking", "we're looking", "recruiter",
    "recruiting", "talent", "interview", "salary", "rate", "contract",
    "full-time", "full time", "remote", "candidate", "apply", "cv", "resume",
  ];
  return signals.some((s) => hay.includes(s));
}
