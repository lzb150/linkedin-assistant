# Score Saturation (Top-N Skill Cap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the skill contribution in `scoreMessage` to the top `maxSkills` (default 8) matched weights, so keyword-stuffed postings stop outscoring real matches.

**Architecture:** The skill loop in `lib/relevance.mjs` collects matched `[skill, weight]` pairs instead of summing inline; the score then adds only the sum of the top-N weights (N = `profile.maxSkills ?? 8`). `matchedSkills` still reports every match. Role bonus (+6) and anti-keywords are not capped. `skills.json` gains an optional `maxSkills` key with a comment.

**Tech Stack:** Node.js (ESM), `node:test`, no external dependencies.

---

## File Structure

- `lib/relevance.mjs` (modify) — skill loop in `scoreMessage`: collect weights, cap-sum.
- `skills.json` (modify) — `_maxSkillsComment` + `maxSkills: 8`.
- `test/relevance.test.mjs` (modify) — saturation tests.

Current skill loop in `scoreMessage` (for reference — this is what gets replaced):

```js
  // Skill matches (each concept counts once, by weight — key OR any synonym).
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (conceptMatches(hay, skill, profile.synonyms?.[skill])) {
      score += weight;
      matchedSkills.push(skill);
    }
  }
```

---

## Task 1: Cap skill contribution in scoreMessage

**Files:**
- Modify: `lib/relevance.mjs` (the skill loop inside `scoreMessage`)
- Test: `test/relevance.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/relevance.test.mjs`. Note: `profile` is already exported from `lib/relevance.mjs`; extend the existing `scoreMessage` import line or add a new import for `profile`:

```js
import { profile } from "../lib/relevance.mjs";

test("scoreMessage caps skill contribution at maxSkills (saturation)", () => {
  const stuffed =
    "QA Automation Engineer. typescript playwright selenium cypress webdriverio java python sql " +
    "api testing rest soap cucumber bdd jenkins ci/cd microservices e2e regression test framework";
  const r = scoreMessage(stuffed);
  const cap = profile.maxSkills ?? 8;
  assert.ok(r.matchedSkills.length > cap, `case must overflow the cap (${r.matchedSkills.length} matched)`);
  const topN = r.matchedSkills
    .map((s) => profile.skills[s])
    .sort((a, b) => b - a)
    .slice(0, cap)
    .reduce((a, b) => a + b, 0);
  assert.equal(r.score, 6 + topN); // role bonus + capped skill sum
  assert.ok(r.score < 50, `stuffed score ${r.score} should be well below the old uncapped 72`);
});

test("scoreMessage still reports every matched skill despite the cap", () => {
  const stuffed =
    "QA Automation Engineer. typescript playwright selenium cypress webdriverio java python sql " +
    "api testing rest soap cucumber bdd jenkins ci/cd microservices e2e regression test framework";
  const r = scoreMessage(stuffed);
  assert.ok(r.matchedSkills.includes("typescript"));
  assert.ok(r.matchedSkills.includes("regression"), "low-weight matches stay in matchedSkills");
});

test("scoreMessage keeps a rich real vacancy above the cold-application gate", () => {
  const rich =
    "Senior AQA Engineer. Playwright, TypeScript, API testing, REST, CI/CD, Jenkins, e2e, " +
    "test framework design, microservices.";
  const r = scoreMessage(rich);
  assert.ok(r.score >= 25, `rich vacancy score ${r.score} must clear minScore 25`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/relevance.test.mjs`
Expected: FAIL — the saturation test gets the uncapped sum (score 72 ≠ 6 + topN), and the `< 50` assertion fails. The other two may pass (they assert behavior that exists today); that is fine — the saturation test is the red one.

- [ ] **Step 3: Implement the cap**

In `lib/relevance.mjs`, replace the skill loop inside `scoreMessage`:

```js
  // Skill matches (each concept counts once, by weight — key OR any synonym).
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (conceptMatches(hay, skill, profile.synonyms?.[skill])) {
      score += weight;
      matchedSkills.push(skill);
    }
  }
```

with:

```js
  // Skill matches (each concept counts once — key OR any synonym). Only the
  // top `maxSkills` weights count toward the score, so keyword-stuffed
  // postings can't outscore real matches; matchedSkills still lists every hit.
  const matchedWeights = [];
  for (const [skill, weight] of Object.entries(profile.skills)) {
    if (conceptMatches(hay, skill, profile.synonyms?.[skill])) {
      matchedWeights.push(weight);
      matchedSkills.push(skill);
    }
  }
  score += matchedWeights
    .sort((a, b) => b - a)
    .slice(0, profile.maxSkills ?? 8)
    .reduce((a, w) => a + w, 0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/relevance.test.mjs`
Expected: PASS — including the pre-existing "English baseline unchanged" test (score still exactly 27: only 5 skills match, under the cap).

- [ ] **Step 5: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass (relevance, dedup, prune, notify-state).

- [ ] **Step 6: Commit**

```bash
git add lib/relevance.mjs test/relevance.test.mjs
git commit -m "feat: cap skill score contribution at top-N weights (saturation)"
```

---

## Task 2: Expose maxSkills in skills.json

**Files:**
- Modify: `skills.json`

- [ ] **Step 1: Add the key**

In `skills.json`, find the closing of the `synonyms` block:

```json
    "e2e": ["наскрізне тестування", "сквозне тестування", "сквозное тестирование"]
  },
  "antiKeywords": {
```

and replace it with:

```json
    "e2e": ["наскрізне тестування", "сквозне тестування", "сквозное тестирование"]
  },
  "_maxSkillsComment": "Only the N highest-weight matched skills count toward the score — guards against keyword-stuffed postings outscoring real matches. Role bonus and antiKeywords are not capped. Omit to use the default (8).",
  "maxSkills": 8,
  "antiKeywords": {
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('skills.json','utf8'));console.log('json ok')"`
Expected: `json ok`

- [ ] **Step 3: Run the full suite (config now feeds the cap)**

Run: `node --test`
Expected: all pass — the saturation test derives its expectation from `profile.maxSkills ?? 8`, so an explicit `maxSkills: 8` keeps it green while now exercising the config path.

- [ ] **Step 4: Sanity-check the headline numbers**

Run:

```bash
node --input-type=module -e '
import { scoreMessage } from "./lib/relevance.mjs";
const cases = {
  baseline: "Looking for a QA Automation Engineer with Playwright, TypeScript, API testing, CI/CD.",
  rich: "Senior AQA Engineer. Playwright, TypeScript, API testing, REST, CI/CD, Jenkins, e2e, test framework design, microservices.",
  stuffed: "QA Automation Engineer. typescript playwright selenium cypress webdriverio java python sql api testing rest soap cucumber bdd jenkins ci/cd microservices e2e regression test framework",
};
for (const [k, v] of Object.entries(cases)) console.log(k, scoreMessage(v).score);
'
```

Expected: `baseline 27`, `rich` ≥ 25 (≈30), `stuffed` ≈ 40 (well below 72).

- [ ] **Step 5: Commit**

```bash
git add skills.json
git commit -m "feat: add maxSkills saturation cap to skills.json"
```

---

## Self-Review Notes

- **Spec coverage:** cap mechanism + default 8 (Task 1 Step 3), `matchedSkills` uncapped (Task 1 tests), role/anti not capped (cap applies only to `matchedWeights`), config key + comment (Task 2 Step 1), baseline 27 no-regression (existing test, re-run Task 1 Step 4), rich ≥ 25 and stuffed compressed (Task 1 Step 1, Task 2 Step 4). No threshold changes anywhere — matches Out of scope.
- **Type consistency:** `profile.maxSkills ?? 8` used identically in implementation and tests; `matchedWeights` local to `scoreMessage`.
- **No placeholders:** every step has concrete code/commands and expected output.
