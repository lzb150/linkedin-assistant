// make-skills.mjs turns a resume into skills.json with one CLI call. Everything
// the model hands back is normalized before it is written, because a broken
// profile does not fail loudly — it silently scores every vacancy wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, profileIsUsable, serializeProfile, buildSkillsPrompt, LIMITS } from "../lib/skills-profile.mjs";
import { scoreMessage } from "../lib/relevance.mjs";

const good = {
  roles: ["Senior QA Automation Engineer", "SDET"],
  skills: { TypeScript: 5, Playwright: 5, "API testing": 4, jenkins: 3, docker: 2 },
  synonyms: { "API testing": ["тестування API"] },
  maxSkills: 8,
  antiKeywords: { junior: 2, "manual qa": 6 },
  thresholds: { relevant: 8, maybe: 4 },
  profile: { en: "test automation", uk: "автоматизації тестування", ru: "автоматизации тестирования" },
};

test("normalizeProfile lowercases and de-duplicates the terms the matcher compiles", () => {
  const p = normalizeProfile({ ...good, roles: ["SDET", "sdet", "  Senior QA  ", "", "x"] });
  assert.deepEqual(p.roles, ["sdet", "senior qa"], "case-folded, whitespace-collapsed, blanks and 1-char terms dropped");
  assert.deepEqual(Object.keys(p.skills), ["typescript", "playwright", "api testing", "jenkins", "docker"]);
});

test("normalizeProfile keeps weights inside the range the scorer expects", () => {
  const p = normalizeProfile({ ...good, skills: { a11y: 99, sql: 0, git: -3, rest: "4", bad: "high", perl: 2.6 } });
  assert.equal(p.skills.a11y, 5, "clamped down");
  // Same rule as antiKeywords: take the magnitude, apply the map's sign. Models
  // answer penalties with either sign, and dropping a real skill over a sign
  // typo costs more than reading -3 as "weight 3".
  assert.equal(p.skills.git, 3, "a negative skill weight is read as its magnitude, never stored negative");
  assert.equal(p.skills.rest, 4, "a numeric string is a number");
  assert.equal(p.skills.perl, 3, "rounded");
  assert.ok(!Object.hasOwn(p.skills, "sql"), "weight 0 says nothing; drop it");
  assert.ok(!Object.hasOwn(p.skills, "bad"), "unparsable weight dropped");
});

test("an anti-keyword is stored negative however the model phrased the penalty", () => {
  // The prompt asks for a positive penalty, but models answer both ways; a
  // positive value in antiKeywords would REWARD the thing it warns about.
  const p = normalizeProfile({ ...good, antiKeywords: { junior: 2, intern: -3, "manual qa": 99 } });
  assert.deepEqual(p.antiKeywords, { junior: -2, intern: -3, "manual qa": -10 });
});

test("synonyms are dropped when they point at a skill that does not exist", () => {
  const p = normalizeProfile({ ...good, synonyms: { "api testing": ["тестування API"], ghost: ["привид"], playwright: ["playwright"] } });
  assert.deepEqual(p.synonyms, { "api testing": ["тестування api"] }, "orphan key gone; a synonym equal to its key is not a synonym");
});

test("thresholds: maybe is always the looser gate", () => {
  // Swapped, every relevant match would also be a maybe and the verdict means nothing.
  assert.deepEqual(normalizeProfile({ ...good, thresholds: { relevant: 4, maybe: 9 } }).thresholds, { relevant: 4, maybe: 3 });
  assert.deepEqual(normalizeProfile({ ...good, thresholds: { relevant: 6, maybe: 6 } }).thresholds, { relevant: 6, maybe: 5 });
  assert.deepEqual(normalizeProfile({}).thresholds, { relevant: 8, maybe: 4 }, "missing thresholds fall back");
});

test("the specialization phrase is cut at a word boundary, not mid-word", () => {
  // It is printed mid-sentence ("досвід в <phrase>"), where half a word shows.
  const long = "senior QA automation engineering, specializing in API test automation and CI";
  const p = normalizeProfile({ ...good, profile: { en: long, uk: "автоматизації тестування ", ru: 42 } });
  assert.ok(p.profile.en.length <= LIMITS.profileLen);
  assert.ok(!/\s$/.test(p.profile.en) && long.startsWith(p.profile.en), "a prefix of the original, ending on a whole word");
  assert.equal(p.profile.uk, "автоматизації тестування", "trailing space trimmed");
  assert.equal(p.profile.ru, "", "a non-string is not a phrase");
});

test("normalizeProfile never throws on garbage and reports what is missing", () => {
  for (const junk of [null, undefined, "", 42, [], { roles: "not a list", skills: "nope" }]) {
    const p = normalizeProfile(junk);
    assert.deepEqual(p.roles, []);
    assert.deepEqual(p.skills, {});
    assert.ok(profileIsUsable(p).length, `${JSON.stringify(junk)} must be rejected, not written`);
  }
  assert.deepEqual(profileIsUsable(normalizeProfile(good)), [], "a real profile passes");
  assert.match(profileIsUsable(normalizeProfile({ ...good, skills: { sql: 1, css: 2 } })).join(";"), /only 2 skills/);
  assert.deepEqual(normalizeProfile({ ...good, skills: { a: 5, b: 5 } }).skills, {}, "a one-character term matches half the internet; it is not a skill");
});

test("the caps hold, so one runaway answer cannot become an unreadable profile", () => {
  const many = (n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => [f(i), 3]));
  const p = normalizeProfile({
    ...good,
    roles: Array.from({ length: 200 }, (_, i) => `role ${i}`),
    skills: many(200, (i) => `skill ${i}`),
    antiKeywords: many(200, (i) => `bad ${i}`),
    maxSkills: 999,
  });
  assert.equal(p.roles.length, LIMITS.roles);
  assert.equal(Object.keys(p.skills).length, LIMITS.skills);
  assert.equal(Object.keys(p.antiKeywords).length, LIMITS.antiKeywords);
  assert.equal(p.maxSkills, LIMITS.maxSkills[1]);
  assert.ok(p.roles.every((r) => r.length <= LIMITS.roleLen));
});

test("a generated profile is something lib/relevance.mjs can actually score with", () => {
  // The whole point: the file this writes is the first gate every vacancy hits.
  const p = normalizeProfile(good);
  const parsed = JSON.parse(serializeProfile(p));
  const onProfile = scoreMessage("Senior QA Automation Engineer — Playwright, TypeScript, API testing, Jenkins", parsed);
  const off = scoreMessage("Manual QA, junior position, no automation", parsed);
  assert.equal(onProfile.matchedRole, "senior qa automation engineer");
  assert.equal(onProfile.verdict, "relevant");
  assert.ok(off.score < onProfile.score, "the anti-keywords pull the wrong vacancy down");
  assert.ok(off.penalties.includes("manual qa"));
});

test("serializeProfile keeps the comments the README tells people to read", () => {
  const out = serializeProfile(normalizeProfile(good), { resumeName: "cv.txt" });
  assert.match(out, /generated from cv\.txt by make-skills\.mjs/);
  for (const key of ["_comment", "_synonymsComment", "_maxSkillsComment", "_profileComment"]) {
    assert.ok(Object.hasOwn(JSON.parse(out), key), `${key} survives the round trip`);
  }
  assert.equal(JSON.parse(out).thresholds.relevant, 8, "thresholds keep their own inline comment and their values");
  assert.ok(out.endsWith("\n"));
});

test("buildSkillsPrompt grounds the answer in the resume and caps how much it sends", () => {
  const prompt = buildSkillsPrompt("x".repeat(50_000));
  assert.ok(prompt.includes("JSON only"), "the caller parses the answer, so say so");
  assert.ok(prompt.length < 20_000, "a pasted book must not become the prompt");
  assert.match(buildSkillsPrompt("MY RESUME TEXT"), /MY RESUME TEXT/);
});

test("intIn rejects booleans, so \"maxSkills\": true cannot silently mean one skill", () => {
  // Number(true) is 1, so this normalized to maxSkills 1: every vacancy scored
  // on a single skill, fell under both thresholds, and the run wrote nothing
  // with a clean log. lib/filters.mjs numberIn already refused booleans for the
  // same reason; the two untrusted-config normalizers now agree.
  assert.equal(normalizeProfile({ maxSkills: true }).maxSkills, 8, "true is not 1");
  assert.equal(normalizeProfile({ maxSkills: false }).maxSkills, 8);
  assert.equal(normalizeProfile({ maxSkills: null }).maxSkills, 8);
  assert.equal(normalizeProfile({ maxSkills: [] }).maxSkills, 8);
  // Real values, including the numeric strings the README invites, still work.
  assert.equal(normalizeProfile({ maxSkills: 12 }).maxSkills, 12);
  assert.equal(normalizeProfile({ maxSkills: "12" }).maxSkills, 12);
});

test("maybe stays strictly looser than relevant, including at the bottom of the range", () => {
  // relevant:1 produced maybe:1 — the exact state the correction exists to rule
  // out. scoreMessage tests `score >= relevant` first, so the "maybe" verdict
  // became unreachable while the code claimed it had fixed the ordering.
  const at = (relevant, maybe) => normalizeProfile({ thresholds: { relevant, maybe } }).thresholds;
  assert.deepEqual(at(1, 5), { relevant: 2, maybe: 1 }, "relevant floors at 2 so the gates can differ");
  assert.deepEqual(at(2, 9), { relevant: 2, maybe: 1 });
  assert.deepEqual(at(8, 4), { relevant: 8, maybe: 4 }, "a sane pair is untouched");
  assert.deepEqual(at(5, 5), { relevant: 5, maybe: 4 }, "equal still collapses to looser");
  for (const [r, m] of [[1, 5], [2, 9], [5, 5], [8, 4], [100, 100]]) {
    const th = at(r, m);
    assert.ok(th.maybe < th.relevant, `maybe(${th.maybe}) must be < relevant(${th.relevant})`);
  }
});
