// Turn a resume into the keyword profile jobs.mjs screens with (skills.json).
//
// The profile is the FIRST gate — cheap, local, no LLM — so it decides which
// vacancies are ever worth a CLI call. Writing it by hand is the one setup step
// a new user cannot copy from an example: the shipped skills.json is a QA
// automation profile, and anyone else silently gets somebody else's vacancies.
//
// The model drafts it; everything it hands back is normalized here before it is
// written, because a profile with a string where a weight belongs, or a role of
// 4000 characters, would not fail loudly — it would just quietly score every
// posting wrong.

// Wide enough for a real career, tight enough that a runaway answer cannot turn
// into a profile nobody can read or a regex that takes a second per vacancy.
export const LIMITS = {
  roles: 40, roleLen: 60,
  skills: 60, skillLen: 40, weight: [1, 5],
  synonymsPerSkill: 12,
  antiKeywords: 20, antiWeight: [-10, -1],
  maxSkills: [1, 20],
  profileLen: 60,
};

const str = (v) => (typeof v === "string" ? v.trim() : "");
const lower = (v) => str(v).toLowerCase().replace(/\s+/g, " ");
const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, n));

// A term the matcher can actually use: non-empty, single-line, bounded. The
// matcher escapes regex metacharacters itself, so nothing needs stripping here —
// only length, because every term becomes a regex compiled once per run.
const term = (v, max) => {
  const s = lower(v).slice(0, max);
  return s.length >= 2 ? s : "";
};

// The specialization phrase is printed mid-sentence ("досвід в <phrase>"), so a
// hard slice would cut a word in half there. Trim to the last word boundary
// that fits and drop the punctuation that trimming can leave hanging.
function phrase(v) {
  const s = str(v).replace(/\s+/g, " ");
  if (s.length <= LIMITS.profileLen) return s.replace(/[\s,;:.]+$/, "");
  const cut = s.slice(0, LIMITS.profileLen);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "");
}

// Booleans are rejected for the same reason lib/filters.mjs numberIn rejects
// them: Number(true) is 1, so "maxSkills": true used to normalize to 1 and the
// run scored every vacancy on a single skill, fell under both thresholds, and
// wrote nothing — silently. The two untrusted-config normalizers now agree.
const intIn = (v, range, fallback) => {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, range) : fallback;
};

function termList(raw, max, len) {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const t = term(v, len);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function weightMap(raw, { max, len, range, sign = 1 }) {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (Object.keys(out).length >= max) break;
    const t = term(k, len);
    if (!t || Object.hasOwn(out, t)) continue;
    // Magnitude, then the map's own sign. Models answer penalties both ways, and
    // a positive number in antiKeywords would REWARD the thing it warns about;
    // a negative one in skills would subtract from the score. Reading either as
    // "3 points, in this map's direction" is safer than trusting the sign, and
    // cheaper than dropping a real skill over a typo.
    const n = Math.round(Math.abs(Number(v)));
    if (!Number.isFinite(n) || n === 0) continue;
    out[t] = clamp(n * sign, range);
  }
  return out;
}

/**
 * Normalize whatever the model produced into a profile lib/relevance.mjs can
 * read. Never throws: anything unusable is dropped, and the caller decides
 * whether what survived is enough (see `profileIsUsable`).
 */
export function normalizeProfile(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const skills = weightMap(o.skills, { max: LIMITS.skills, len: LIMITS.skillLen, range: LIMITS.weight });

  // Synonyms only make sense for a skill that exists: an orphan key can never
  // match anything, and would sit in the file looking like it does.
  const synonyms = {};
  for (const [k, v] of Object.entries(o.synonyms && typeof o.synonyms === "object" ? o.synonyms : {})) {
    const key = term(k, LIMITS.skillLen);
    if (!key || !Object.hasOwn(skills, key)) continue;
    const list = termList(v, LIMITS.synonymsPerSkill, LIMITS.skillLen).filter((s) => s !== key);
    if (list.length) synonyms[key] = list;
  }

  const thresholds = {
    // Floor of 2, not 1: the correction below derives `maybe` as relevant - 1
    // and clamps it to >= 1, so relevant = 1 produced maybe = 1 — the very
    // state the correction exists to rule out, and scoreMessage tests
    // `score >= relevant` first, so the "maybe" verdict became unreachable.
    // A relevant of 1 means "everything matches" anyway; 2 is the lowest value
    // at which the two gates can still be distinct.
    relevant: intIn(o.thresholds?.relevant, [2, 100], 8),
    maybe: intIn(o.thresholds?.maybe, [1, 100], 4),
  };
  // "maybe" is the looser gate by definition; a model that swaps them would
  // make every relevant match also a maybe and the verdict meaningless.
  if (thresholds.maybe >= thresholds.relevant) thresholds.maybe = Math.max(1, thresholds.relevant - 1);

  const profile = {};
  for (const lang of ["en", "uk", "ru"]) profile[lang] = phrase(o.profile?.[lang]);

  return {
    roles: termList(o.roles, LIMITS.roles, LIMITS.roleLen),
    skills,
    synonyms,
    maxSkills: intIn(o.maxSkills, LIMITS.maxSkills, 8),
    antiKeywords: weightMap(o.antiKeywords, { max: LIMITS.antiKeywords, len: LIMITS.skillLen, range: LIMITS.antiWeight, sign: -1 }),
    thresholds,
    profile,
  };
}

// Enough to screen with. A profile with no roles never matches the role bonus,
// and one with a handful of skills scores everything the same — better to say
// so than to write a file that silently drops every vacancy.
export function profileIsUsable(p) {
  const problems = [];
  if (!p.roles.length) problems.push("no roles");
  if (Object.keys(p.skills).length < 5) problems.push(`only ${Object.keys(p.skills).length} skills (need 5+)`);
  if (!p.profile.en) problems.push("no English specialization phrase");
  return problems;
}

// The file as it is written: the comments are part of the contract, since the
// README tells people to edit this by hand afterwards.
export function serializeProfile(p, { resumeName = "resume.txt" } = {}) {
  return JSON.stringify({
    _comment: `Skill profile generated from ${resumeName} by make-skills.mjs. 'weight' = how strongly a match counts. Edit freely — this file is yours, and regenerating overwrites it only with --force. Roles you'd accept go in 'roles'; deal-breakers that should LOWER relevance go in 'antiKeywords'.`,
    roles: p.roles,
    skills: p.skills,
    _synonymsComment: "Cross-language equivalents for conceptual skills. A skill's weight (from 'skills') counts ONCE if the key OR any synonym matches. Latin tech terms (playwright, typescript, c#) need no synonyms — they appear in Latin in UA/RU text.",
    synonyms: p.synonyms,
    _maxSkillsComment: "Only the N highest-weight matched skills count toward the score — guards against keyword-stuffed postings outscoring real matches. Role bonus and antiKeywords are not capped.",
    maxSkills: p.maxSkills,
    antiKeywords: p.antiKeywords,
    thresholds: { _comment: "score >= relevant -> draft + 'attach resume'. score >= maybe -> draft flagged for your judgment. below maybe -> logged only, no draft.", ...p.thresholds },
    _profileComment: "How the FALLBACK cover letters describe your specialization, per language (LLM letters ignore this — they are grounded in resume.txt). Cyrillic phrases sit in genitive position — 'досвід в …' / 'опыт в …' — so word them to fit that case.",
    profile: p.profile,
  }, null, 2) + "\n";
}

export function buildSkillsPrompt(resume) {
  return `You are building a keyword screening profile for one person's job search, from their resume.

RESUME:
${String(resume).slice(0, 12000)}

Answer with JSON only — no prose, no code fence — in exactly this shape:

{
  "roles": ["job titles this person would accept, lowercase"],
  "skills": {"skill or tool": 1-5},
  "synonyms": {"skill from the list above": ["the same concept in Ukrainian", "and Russian"]},
  "maxSkills": 8,
  "antiKeywords": {"term that makes a vacancy a WORSE fit": 2},
  "thresholds": {"relevant": 8, "maybe": 4},
  "profile": {"en": "their specialization", "uk": "те саме українською", "ru": "то же по-русски"}
}

Rules:
- roles: 10-30 titles, including seniority variants and the Ukrainian spellings a local board would use. These are matched against a vacancy TITLE.
- skills: 20-50 entries. Weight 5 = the person's core, daily tools; 1 = touched it once. Include languages, frameworks, tools and practices, not soft skills.
- synonyms: only for CONCEPTS that appear translated on Ukrainian boards ("test automation" -> "автоматизація тестування"). Latin tech names (playwright, typescript, c#) need none — skip them.
- antiKeywords: 5-15 terms meaning this vacancy is a poor fit — a seniority below theirs, a stack they do not work in, a role type they left behind. Give the PENALTY as a positive number 1-10; it is stored negative.
- profile: a SHORT noun phrase naming the specialization — at most 5 words, no seniority, no "specializing in". It is printed mid-sentence after "досвід в" / "опыт в", so the Cyrillic ones must be in the genitive case.
Return only the JSON object.`;
}
