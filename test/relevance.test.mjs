import { test } from "node:test";
import assert from "node:assert/strict";
import { stemCyrillic, mentionsStem } from "../lib/relevance.mjs";

test("stemCyrillic reduces UA declensions of a noun to one stem prefix", () => {
  const stem = stemCyrillic("автоматизація");
  assert.ok("автоматизації".startsWith(stem), `"автоматизації" should start with "${stem}"`);
  assert.ok("автоматизацію".startsWith(stem), `"автоматизацію" should start with "${stem}"`);
});

test("stemCyrillic reduces a UA verbal noun so other case forms share the stem", () => {
  const stem = stemCyrillic("тестування");
  assert.ok("тестуванні".startsWith(stem), `"тестуванні" should start with "${stem}"`);
  assert.ok("тестувань".startsWith(stem), `"тестувань" should start with "${stem}"`);
});

test("stemCyrillic does not over-stem a short consonant-ending word", () => {
  assert.equal(stemCyrillic("досвід"), "досвід");
});

test("stemCyrillic leaves Latin words unchanged", () => {
  assert.equal(stemCyrillic("Playwright"), "playwright");
});

test("mentionsStem matches a Cyrillic phrase across declensions", () => {
  const hay = "маємо досвід автоматизації тестування продукту".toLowerCase();
  assert.equal(mentionsStem(hay, "автоматизація тестування"), true);
});

test("mentionsStem does not match when the stem is absent", () => {
  const hay = "ручне тестування веб-додатків".toLowerCase();
  assert.equal(mentionsStem(hay, "автоматизація тестування"), false);
});

test("mentionsStem falls back to exact matching for Latin terms", () => {
  assert.equal(mentionsStem("we use playwright daily", "playwright"), true);
  assert.equal(mentionsStem("backend in c# here", "c#"), true);
  assert.equal(mentionsStem("strong ci/cd skills", "ci/cd"), true);
  assert.equal(mentionsStem("we test apis", "api"), false);
});

test("mentionsStem enforces a right-word boundary", () => {
  assert.equal(mentionsStem("автоматизаціяfoo у тексті", "автоматизація"), false);
  assert.equal(mentionsStem("we did apis", "тестування api"), false);
});

test("mentionsStem handles a mixed Latin+Cyrillic phrase", () => {
  assert.equal(mentionsStem("шукаємо автоматизація api у команді", "автоматизація api"), true);
});

import { scoreMessage, profile } from "../lib/relevance.mjs";

test("scoreMessage matches a UA role-worded vacancy and clears the jobs.mjs gate", () => {
  const text = "Шукаємо фронтенд розробника. Досвід: React, Next.js, TypeScript, Node.js, WebSockets, CI/CD.";
  const r = scoreMessage(text);
  assert.ok(r.matchedRole, "UA role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
  assert.equal(r.verdict, "relevant");
});

test("scoreMessage matches a RU role-worded vacancy", () => {
  const text = "Требуется фронтенд разработчик. Стек: React, Redux, TypeScript, JavaScript, Node.js, REST, CI/CD.";
  const r = scoreMessage(text);
  assert.ok(r.matchedRole, "RU role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
});

test("scoreMessage keeps the English baseline unchanged (no regression)", () => {
  const text = "Looking for a Senior Frontend Engineer with React, Next.js, TypeScript, Node.js.";
  const r = scoreMessage(text);
  assert.equal(r.matchedRole, "frontend engineer");
  // 6 role + react 5 + next.js 5 + typescript 5 + node.js 4 + frontend 3
  assert.equal(r.score, 28);
});

test("scoreMessage counts a concept once when English key and UA synonym both appear", () => {
  // "frontend" (3) counts once even though the key, a spelling variant, and the UA synonym all appear.
  const r = scoreMessage("frontend front-end фронтенд");
  assert.equal(r.matchedRole, null);
  assert.equal(r.score, 3);
});

test("scoreMessage does not double-count a concept matched via key and synonym", () => {
  // "WebSockets" matches the "websocket" concept via its synonym only (3) — not twice.
  const r = scoreMessage("real-time feed over WebSockets");
  assert.equal(r.score, 3);
});

test("scoreMessage matches a UA hyphenated role phrasing", () => {
  const r = scoreMessage("Потрібен фронтенд-розробник зі знанням React та TypeScript.");
  assert.ok(r.matchedRole, "UA hyphenated role should be matched");
  assert.equal(r.verdict, "relevant");
});

test("scoreMessage caps skill contribution at maxSkills (saturation)", () => {
  const stuffed =
    "Frontend Developer. react next.js typescript node.js javascript websocket module federation " +
    "micro-frontend sse ssr mobx zustand redux express tailwind postgresql prisma jest cloudflare " +
    "docker ci/cd rest canvas";
  const r = scoreMessage(stuffed);
  const cap = profile.maxSkills ?? 8;
  assert.ok(r.matchedSkills.length > cap, `case must overflow the cap (${r.matchedSkills.length} matched)`);
  const topN = r.matchedSkills
    .map((s) => profile.skills[s])
    .sort((a, b) => b - a)
    .slice(0, cap)
    .reduce((a, b) => a + b, 0);
  assert.equal(r.score, 6 + topN); // role bonus + capped skill sum
  assert.equal(r.score, 40); // pinned: 6 role + top-8 weights of the current profile
  assert.ok(r.score < 50, `stuffed score ${r.score} should be well below the uncapped sum`);
});

test("scoreMessage still reports every matched skill despite the cap", () => {
  const stuffed =
    "Frontend Developer. react next.js typescript node.js javascript websocket module federation " +
    "micro-frontend sse ssr mobx zustand redux express tailwind postgresql prisma jest cloudflare " +
    "docker ci/cd rest canvas";
  const r = scoreMessage(stuffed);
  assert.ok(r.matchedSkills.includes("typescript"));
  assert.ok(r.matchedSkills.includes("canvas"), "low-weight matches stay in matchedSkills");
});

test("scoreMessage keeps a rich real vacancy above the cold-application gate", () => {
  const rich =
    "Senior Frontend Engineer. React, Next.js, TypeScript, MobX, WebSockets, SSR, " +
    "Module Federation, Jest, CI/CD.";
  const r = scoreMessage(rich);
  assert.ok(r.score >= 25, `rich vacancy score ${r.score} must clear minScore 25`);
});
