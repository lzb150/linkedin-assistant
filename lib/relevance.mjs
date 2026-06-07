// Local, dependency-free relevance scoring.
// Compares a LinkedIn message (ideally containing a job description) against
// your skill profile in skills.json. No network, no API key, nothing leaves the machine.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(readFileSync(join(__dir, "..", "skills.json"), "utf8"));

// Match a multi-word phrase as a whole-word-ish substring (case-insensitive).
function mentions(haystack, phrase) {
  // escape regex special chars, allow flexible whitespace between words
  const pat = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^a-z0-9+#])${pat}([^a-z0-9+#]|$)`, "i");
  return re.test(haystack);
}

/**
 * Score one message's text.
 * @returns { score, matchedSkills, matchedRole, penalties, verdict }
 *   verdict: "relevant" | "maybe" | "ignore"
 */
export function scoreMessage(text) {
  const hay = (text || "").toLowerCase();
  let score = 0;
  const matchedSkills = [];
  const penalties = [];

  // Role match is a strong signal — counts once, weighted heavily.
  let matchedRole = null;
  for (const role of profile.roles) {
    if (mentions(hay, role)) {
      matchedRole = role;
      score += 6;
      break;
    }
  }

  // Skill keyword matches (each counts once, by weight).
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (mentions(hay, skill)) {
      score += weight;
      matchedSkills.push(skill);
    }
  }

  // Anti-keywords reduce the score.
  for (const [bad, weight] of Object.entries(profile.antiKeywords || {})) {
    if (mentions(hay, bad)) {
      score += weight; // weight is negative
      penalties.push(bad);
    }
  }

  const t = profile.thresholds || { relevant: 8, maybe: 4 };
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

export { profile };
