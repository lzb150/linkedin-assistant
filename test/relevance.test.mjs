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

import { scoreMessage } from "../lib/relevance.mjs";

// Frozen QA profile fixture (a snapshot of the historical skills.json). Score
// pins below are computed against THIS object, so editing the live skills.json
// for your own profession never breaks these tests.
const QA = {
  roles: [
    "qa automation", "automation qa", "sdet", "software development engineer in test",
    "test automation engineer", "automation engineer", "qa engineer", "test engineer",
    "senior qa", "lead qa", "automation tester", "quality engineer",
    "інженер з автоматизації тестування", "інженер з автоматизованого тестування",
    "інженер з тестування", "автоматизатор тестування", "автоматизатор",
    "інженер із забезпечення якості",
    "спеціаліст з автоматизованого тестування", "спеціаліст з автоматизації тестування",
    "спеціаліст з тестування", "тестувальник автоматизації", "qa інженер", "qa-інженер",
    "инженер по автоматизации тестирования", "инженер автоматизации тестирования",
    "автоматизатор тестирования", "инженер по тестированию", "тестировщик-автоматизатор",
  ],
  skills: {
    typescript: 5, playwright: 5, sdet: 5, "test automation": 5, automation: 4,
    "api testing": 4, "api automation": 4, rest: 3, soap: 2, webdriverio: 4,
    selenium: 4, testcafe: 3, cypress: 3, java: 4, "c#": 2, python: 2,
    cucumber: 3, bdd: 3, testng: 2, junit: 2, jenkins: 3, gitlab: 2,
    "ci/cd": 3, jira: 1, postman: 2, wiremock: 2, rabbitmq: 2, microservices: 3,
    kibana: 1, newrelic: 1, "report portal": 1, mongodb: 2, "ms sql": 1,
    oracle: 1, sql: 2, e2e: 4, "end-to-end": 4, regression: 2,
    "test framework": 3, "test strategy": 2, sdlc: 1,
  },
  synonyms: {
    "test automation": ["автоматизація тестування", "автоматизоване тестування", "автоматизація тестів", "автотести", "автоматизация тестирования", "автотесты"],
    automation: ["автоматизація", "автоматизация"],
    "api testing": ["тестування api", "тестування апі", "тестирование api"],
    "api automation": ["автоматизація api", "автоматизация api"],
    "test framework": ["тестовий фреймворк", "фреймворк для тестування", "тестовый фреймворк"],
    "test strategy": ["стратегія тестування", "стратегия тестирования"],
    regression: ["регресійне тестування", "регресія", "регрессионное тестирование", "регрессия"],
    e2e: ["наскрізне тестування", "сквозне тестування", "сквозное тестирование"],
  },
  maxSkills: 8,
  antiKeywords: {
    "manual qa": -6, "manual testing only": -4, "no automation": -5, unpaid: -6,
    internship: -3, "relocation required": -1, "on-site only": -1, php: -1,
    "ruby on rails": -1,
  },
  thresholds: { relevant: 8, maybe: 4 },
};

test("scoreMessage matches a UA role-worded vacancy and clears the jobs.mjs gate", () => {
  const text = "Шукаємо інженера з автоматизації тестування. Досвід: Playwright, TypeScript, автоматизація тестування, CI/CD, API.";
  const r = scoreMessage(text, QA);
  assert.ok(r.matchedRole, "UA role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
  assert.equal(r.verdict, "relevant");
});

test("scoreMessage matches a RU role-worded vacancy", () => {
  const text = "Требуется инженер по автоматизации тестирования. Стек: автоматизация тестирования, Selenium, Java, Python, REST, CI/CD.";
  const r = scoreMessage(text, QA);
  assert.ok(r.matchedRole, "RU role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
});

test("scoreMessage keeps the English baseline unchanged (no regression)", () => {
  const text = "Looking for a QA Automation Engineer with Playwright, TypeScript, API testing, CI/CD.";
  const r = scoreMessage(text, QA);
  assert.equal(r.matchedRole, "qa automation");
  assert.equal(r.score, 27);
});

test("scoreMessage counts a concept once when English key and UA synonym both appear", () => {
  // "test automation" (5, once) + "automation" (4, once) = 9, not doubled.
  const r = scoreMessage("test automation автоматизація тестування", QA);
  assert.equal(r.matchedRole, null);
  assert.equal(r.score, 9);
});

test("scoreMessage does not double-count a concept shared between two skill keys", () => {
  // "наскрізне тестування" is an e2e synonym (4) only — not also end-to-end.
  const r = scoreMessage("наскрізне тестування продукту", QA);
  assert.equal(r.score, 4);
});

test("scoreMessage matches a UA 'спеціаліст' role phrasing", () => {
  const r = scoreMessage("Потрібен спеціаліст з автоматизованого тестування, написання автотестів.", QA);
  assert.ok(r.matchedRole, "UA 'спеціаліст' role should be matched");
  assert.equal(r.verdict, "relevant");
});

test("scoreMessage caps skill contribution at maxSkills (saturation)", () => {
  const stuffed =
    "QA Automation Engineer. typescript playwright selenium cypress webdriverio java python sql " +
    "api testing rest soap cucumber bdd jenkins ci/cd microservices e2e regression test framework";
  const r = scoreMessage(stuffed, QA);
  const cap = QA.maxSkills ?? 8;
  assert.ok(r.matchedSkills.length > cap, `case must overflow the cap (${r.matchedSkills.length} matched)`);
  const topN = r.matchedSkills
    .map((s) => QA.skills[s])
    .sort((a, b) => b - a)
    .slice(0, cap)
    .reduce((a, b) => a + b, 0);
  assert.equal(r.score, 6 + topN); // role bonus + capped skill sum
  assert.equal(r.score, 40); // pinned: 6 role + top-8 weights of the current profile
  assert.ok(r.score < 50, `stuffed score ${r.score} should be well below the old uncapped 72`);
});

test("scoreMessage still reports every matched skill despite the cap", () => {
  const stuffed =
    "QA Automation Engineer. typescript playwright selenium cypress webdriverio java python sql " +
    "api testing rest soap cucumber bdd jenkins ci/cd microservices e2e regression test framework";
  const r = scoreMessage(stuffed, QA);
  assert.ok(r.matchedSkills.includes("typescript"));
  assert.ok(r.matchedSkills.includes("regression"), "low-weight matches stay in matchedSkills");
});

test("scoreMessage keeps a rich real vacancy above the cold-application gate", () => {
  const rich =
    "Senior AQA Engineer. Playwright, TypeScript, API testing, REST, CI/CD, Jenkins, e2e, " +
    "test framework design, microservices.";
  const r = scoreMessage(rich, QA);
  // 9 skills matched, no role; the cap drops the lowest weight: expected ≈30.
  assert.ok(r.score >= 25, `rich vacancy score ${r.score} must clear minScore 25`);
});
