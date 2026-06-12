# Cross-Language Relevance Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lib/relevance.mjs` score Ukrainian/Russian-worded vacancies correctly by matching UA/RU role phrasings and skill synonyms, with light Cyrillic stemming for declensions.

**Architecture:** Add a conservative Cyrillic stemmer and a stem-tolerant matcher to `lib/relevance.mjs`. Cyrillic terms match via `stem + [Cyrillic]*` (only the configured term is stemmed; the text's word-ending is absorbed by the wildcard). English/Latin matching is untouched (existing `mentions()`). Skills gain a `synonyms` block in `skills.json` so a concept's weight is counted once whether the English key or any synonym matches; roles gain UA/RU phrasings in the existing flat `roles` array.

**Tech Stack:** Node.js (ESM), `node:test`, no external dependencies.

---

## File Structure

- `lib/relevance.mjs` (modify) — add `hasCyrillic`, `stemCyrillic`, `mentionsStem`, `conceptMatches`; route `scoreMessage` role/skill/anti-keyword matching through them.
- `skills.json` (modify) — append UA/RU role phrasings to `roles`; add a `synonyms` map for conceptual skills.
- `test/relevance.test.mjs` (create) — unit tests for `stemCyrillic` and `mentionsStem`, integration tests for `scoreMessage`.

---

## Task 1: Cyrillic stemmer (`stemCyrillic`)

**Files:**
- Modify: `lib/relevance.mjs`
- Test: `test/relevance.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/relevance.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { stemCyrillic } from "../lib/relevance.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/relevance.test.mjs`
Expected: FAIL — `stemCyrillic` is not exported (`SyntaxError`/import error).

- [ ] **Step 3: Write minimal implementation**

In `lib/relevance.mjs`, add after the `mentions` function (after line 21):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/relevance.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/relevance.mjs test/relevance.test.mjs
git commit -m "feat: add conservative Cyrillic stemmer to relevance scoring"
```

---

## Task 2: Stem-tolerant matcher (`mentionsStem`)

**Files:**
- Modify: `lib/relevance.mjs`
- Test: `test/relevance.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/relevance.test.mjs`:

```js
import { mentionsStem } from "../lib/relevance.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/relevance.test.mjs`
Expected: FAIL — `mentionsStem` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `lib/relevance.mjs`, add immediately after `stemCyrillic`:

```js
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
  const re = new RegExp(`(^|[^a-z0-9${CYR}+#])(?:${body})`, "i");
  return re.test(haystack);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/relevance.test.mjs`
Expected: PASS (all tests, 7 total).

- [ ] **Step 5: Commit**

```bash
git add lib/relevance.mjs test/relevance.test.mjs
git commit -m "feat: add stem-tolerant Cyrillic phrase matcher"
```

---

## Task 3: Wire cross-language matching into scoreMessage + seed skills.json

**Files:**
- Modify: `skills.json`
- Modify: `lib/relevance.mjs:28-66` (the `scoreMessage` function)
- Test: `test/relevance.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/relevance.test.mjs`:

```js
import { scoreMessage } from "../lib/relevance.mjs";

test("scoreMessage matches a UA role-worded vacancy and clears the jobs.mjs gate", () => {
  const text = "Шукаємо інженера з автоматизації тестування. Досвід: Playwright, TypeScript, автоматизація тестування, CI/CD, API.";
  const r = scoreMessage(text);
  assert.ok(r.matchedRole, "UA role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
  assert.equal(r.verdict, "relevant");
});

test("scoreMessage matches a RU role-worded vacancy", () => {
  const text = "Требуется инженер по автоматизации тестирования. Стек: автоматизация тестирования, Selenium, Java, Python, REST, CI/CD.";
  const r = scoreMessage(text);
  assert.ok(r.matchedRole, "RU role should be matched");
  assert.ok(r.score >= 25, `score ${r.score} should clear minScore 25`);
});

test("scoreMessage keeps the English baseline unchanged (no regression)", () => {
  const text = "Looking for a QA Automation Engineer with Playwright, TypeScript, API testing, CI/CD.";
  const r = scoreMessage(text);
  assert.equal(r.matchedRole, "qa automation");
  assert.equal(r.score, 27);
});

test("scoreMessage counts a concept once when English key and UA synonym both appear", () => {
  // "test automation" (5, once) + "automation" (4, once) = 9, not doubled.
  const r = scoreMessage("test automation автоматизація тестування");
  assert.equal(r.matchedRole, null);
  assert.equal(r.score, 9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/relevance.test.mjs`
Expected: FAIL — the UA/RU cases get `matchedRole` null and low scores (current scorer is English-only); the no-double-count case may also differ.

- [ ] **Step 3: Seed `skills.json` with UA/RU roles and a synonyms block**

In `skills.json`, replace the closing `]` of the `"roles"` array so the UA/RU forms are appended. Change the last role line from:

```json
    "senior qa", "lead qa", "automation tester", "quality engineer"
  ],
```

to:

```json
    "senior qa", "lead qa", "automation tester", "quality engineer",
    "інженер з автоматизації тестування", "інженер з автоматизованого тестування",
    "інженер з тестування", "автоматизатор тестування", "автоматизатор",
    "інженер із забезпечення якості",
    "инженер по автоматизации тестирования", "инженер автоматизации тестирования",
    "автоматизатор тестирования", "инженер по тестированию", "тестировщик-автоматизатор"
  ],
```

Then add a new `"synonyms"` block immediately after the closing `}` of the `"skills"` object (before `"antiKeywords"`). Find:

```json
    "sdlc": 1
  },
  "antiKeywords": {
```

and replace it with:

```json
    "sdlc": 1
  },
  "_synonymsComment": "Cross-language equivalents for conceptual skills. A skill's weight (from 'skills') counts ONCE if the key OR any synonym matches. Latin tech terms (playwright, typescript, c#) need no synonyms — they appear in Latin in UA/RU text.",
  "synonyms": {
    "test automation": ["автоматизація тестування", "автоматизоване тестування", "автоматизація тестів", "автотести", "автоматизация тестирования", "автотесты"],
    "automation": ["автоматизація", "автоматизация"],
    "api testing": ["тестування api", "тестування апі", "тестирование api"],
    "api automation": ["автоматизація api", "автоматизация api"],
    "test framework": ["тестовий фреймворк", "фреймворк для тестування", "тестовый фреймворк"],
    "test strategy": ["стратегія тестування", "стратегия тестирования"],
    "regression": ["регресійне тестування", "регресія", "регрессионное тестирование", "регрессия"],
    "e2e": ["наскрізне тестування", "сквозне тестування", "сквозное тестирование"],
    "end-to-end": ["наскрізне тестування", "сквозное тестирование"]
  },
  "antiKeywords": {
```

- [ ] **Step 4: Route scoreMessage matching through the Cyrillic-aware matchers**

In `lib/relevance.mjs`, change the role, skill, and anti-keyword loops in `scoreMessage`.

Replace the role loop:

```js
  let matchedRole = null;
  for (const role of profile.roles) {
    if (mentions(hay, role)) {
      matchedRole = role;
      score += 6;
      break;
    }
  }
```

with:

```js
  let matchedRole = null;
  for (const role of profile.roles) {
    if (mentionsStem(hay, role)) {
      matchedRole = role;
      score += 6;
      break;
    }
  }
```

Replace the skill loop:

```js
  // Skill keyword matches (each counts once, by weight).
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (mentions(hay, skill)) {
      score += weight;
      matchedSkills.push(skill);
    }
  }
```

with:

```js
  // Skill matches (each concept counts once, by weight — key OR any synonym).
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (conceptMatches(hay, skill, profile.synonyms?.[skill])) {
      score += weight;
      matchedSkills.push(skill);
    }
  }
```

Replace the anti-keyword loop:

```js
  // Anti-keywords reduce the score.
  for (const [bad, weight] of Object.entries(profile.antiKeywords || {})) {
    if (mentions(hay, bad)) {
      score += weight; // weight is negative
      penalties.push(bad);
    }
  }
```

with:

```js
  // Anti-keywords reduce the score (English today; routed through the same
  // matcher so a Cyrillic anti-keyword would also work if added later).
  for (const [bad, weight] of Object.entries(profile.antiKeywords || {})) {
    if (mentionsStem(hay, bad)) {
      score += weight; // weight is negative
      penalties.push(bad);
    }
  }
```

Then add the `conceptMatches` helper immediately after `mentionsStem`:

```js
// True if a concept matches the text via its key or any of its synonyms.
// Ensures a concept's weight is added at most once.
function conceptMatches(hay, key, synonyms) {
  if (mentionsStem(hay, key)) return true;
  if (Array.isArray(synonyms)) {
    for (const s of synonyms) if (mentionsStem(hay, s)) return true;
  }
  return false;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/relevance.test.mjs`
Expected: PASS (all tests, 11 total).

- [ ] **Step 6: Run the full suite for regressions**

Run: `node --test`
Expected: PASS — all suites green (dedup, prune, notify-state, relevance).

- [ ] **Step 7: Sanity-check against the original evidence cases**

Run:

```bash
node --input-type=module -e '
import { scoreMessage } from "./lib/relevance.mjs";
for (const t of [
  "Шукаємо інженера з автоматизації тестування. Досвід Playwright, TypeScript, API тестування, CI/CD.",
  "Потрібен спеціаліст з автоматизованого тестування, написання автотестів, перевірка якості ПЗ.",
  "Требуется инженер по автоматизации тестирования. Опыт автотестов, тест-фреймворки.",
  "Looking for a QA Automation Engineer with Playwright, TypeScript, API testing, CI/CD.",
]) { const r = scoreMessage(t); console.log(r.score, r.verdict, "role:", r.matchedRole||"-"); }
'
```

Expected: the three Cyrillic cases now show a non-`-` role (or a clearly higher score than the pre-change 13/0/0), and the English baseline still prints `27 relevant role: qa automation`.

- [ ] **Step 8: Commit**

```bash
git add lib/relevance.mjs skills.json test/relevance.test.mjs
git commit -m "feat: score Ukrainian/Russian-worded vacancies via role/skill synonyms"
```

---

## Self-Review Notes

- **Spec coverage:** roles UA/RU (Task 3 Step 3), skills `synonyms` block + once-only counting (Task 3 Steps 3–4, `conceptMatches`), Cyrillic stemming (Task 1), English matching unchanged (Task 2 fallback + Task 3 role/skill/anti tests), seeded defaults (Task 3 Step 3), tests for `stemCyrillic`/`mentionsStem`/`scoreMessage` incl. no-regression and no-double-count (Tasks 1–3). All spec sections map to a task.
- **Type/name consistency:** `hasCyrillic`, `stemCyrillic`, `mentionsStem`, `conceptMatches`, `CYR`, `CYR_ENDINGS`, `MIN_STEM` used consistently across tasks; `mentionsStem` defined in Task 2 and consumed in Task 3.
- **No placeholders:** every code and command step is concrete.
