# Profession-Agnostic Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the last profession-specific phrase out of code into a `profile` block in `skills.json`, neutralize one recruiter-reply wording, and ship a developer preset + README how-to so switching professions is a pure config change.

**Architecture:** `skills.json` (already the profession profile) gains a `profile` block with the per-language specialization phrase. `lib/application.mjs` loads it at module load (same pattern as `lib/relevance.mjs`) and resolves the phrase through a small exported pure helper `coverPhrase(profile, lang)` whose defaults are the current hard-coded phrases — existing configs produce byte-identical packages.

**Tech Stack:** Node ESM, `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-profession-agnostic-profile-design.md`

## Global Constraints

- No new npm dependencies.
- Backward compatibility: a `skills.json` without a `profile` block (or missing a language key) must produce byte-identical cover notes to today's output — the defaults ARE the current phrases.
- The user's active QA profile stays active: `skills.json` gains the `profile` block with the CURRENT QA phrases; roles/skills/antiKeywords/thresholds are not touched.
- Cyrillic phrases sit in genitive position ("досвід в …" / "опыт в …") — preset values must fit that case.
- The LLM cover path is untouched — `profile` only feeds the fallback templates.
- Repo conventions: `*.example` files for presets; README.md English, README.uk.md Ukrainian mirror; file-header + why-comments style.
- Nothing is ever sent automatically.

---

### Task 1: `coverPhrase` helper + `profile` block + template interpolation

**Files:**
- Modify: `skills.json` (add `_profileComment` + `profile` after the `thresholds` block)
- Modify: `lib/application.mjs` (imports, profile load, `coverPhrase`, the three COVER templates and their call site)
- Test: `test/application.test.mjs` (extend)

**Interfaces:**
- Consumes: existing `buildApplication(job, scored, llm)` and its COVER closures; `skills.json` shape.
- Produces: `coverPhrase(profile, lang) -> string` (exported from `lib/application.mjs`; `profile` is `skills.json`'s `profile` object or `undefined`, `lang` is `"en"|"uk"|"ru"`); COVER closures gain a 4th parameter `spec` (the resolved phrase). Task 2's preset relies on the `profile` block shape `{ en, uk, ru }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/application.test.mjs` (add the imports at the top of the file next to the existing ones):

```js
import { readFileSync } from "node:fs";
import { coverPhrase } from "../lib/application.mjs";
```

```js
test("coverPhrase resolves the profile with per-language legacy defaults", () => {
  const profile = { en: "software development", uk: "розробці", ru: "разработке" };
  assert.equal(coverPhrase(profile, "en"), "software development");
  assert.equal(coverPhrase(profile, "uk"), "розробці");
  // missing language key → legacy phrase for that language
  assert.equal(coverPhrase({ en: "x" }, "ru"), "автоматизации тестирования");
  // empty/blank value → legacy phrase
  assert.equal(coverPhrase({ en: "  " }, "en"), "test automation");
  // no block at all → legacy phrase (backward-compat regression guard)
  assert.equal(coverPhrase(undefined, "en"), "test automation");
  assert.equal(coverPhrase(undefined, "uk"), "автоматизації тестування");
  // unknown language falls back to the en default
  assert.equal(coverPhrase(undefined, "de"), "test automation");
});

test("the cover note routes through skills.json's profile block", () => {
  // Read the real file instead of duplicating the string — proves the
  // template interpolation path, whatever the phrase currently is.
  const { profile } = JSON.parse(readFileSync(new URL("../skills.json", import.meta.url), "utf8"));
  assert.ok(profile && profile.en, "skills.json must carry a profile block after this task");
  const { markdown } = buildApplication(job, scored);
  assert.ok(markdown.includes(`solid experience in ${profile.en},`), "en cover must embed profile.en");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/application.test.mjs`
Expected: FAIL — `coverPhrase` is not exported (SyntaxError on import).

- [ ] **Step 3: Add the `profile` block to `skills.json`**

Inside the top-level object, after the closing `}` of `"thresholds"` (add a comma to it), append before the file's final `}`:

```json
  "_profileComment": "How the FALLBACK cover letters describe your specialization, per language (LLM letters ignore this — they are grounded in resume.txt). Cyrillic phrases sit in genitive position — 'досвід в …' / 'опыт в …' — so word them to fit that case.",
  "profile": {
    "en": "test automation",
    "uk": "автоматизації тестування",
    "ru": "автоматизации тестирования"
  }
```

- [ ] **Step 4: Implement in `lib/application.mjs`**

Add the imports and profile load at the top (after the existing imports):

```js
import { readFileSync } from "node:fs";

// The specialization phrase for the fallback cover letters lives in
// skills.json's profile block — the same file that already defines the
// profession (roles/skills/antiKeywords). Loaded once, like lib/relevance.mjs.
const SKILLS_PROFILE = JSON.parse(
  readFileSync(new URL("../skills.json", import.meta.url), "utf8"),
).profile;

// Legacy phrases double as defaults so a skills.json without a profile block
// keeps producing byte-identical packages.
const DEFAULT_PHRASE = {
  en: "test automation",
  uk: "автоматизації тестування",
  ru: "автоматизации тестирования",
};

export function coverPhrase(profile, lang) {
  const v = profile && typeof profile[lang] === "string" ? profile[lang].trim() : "";
  return v || DEFAULT_PHRASE[lang] || DEFAULT_PHRASE.en;
}
```

Change the three COVER closures to take a 4th param `spec` and interpolate it in place of the hard-coded phrase:

```js
const COVER = {
  en: (title, company, skills, spec) =>
    `Hello,\n\nI came across your "${title}"${company ? " role at " + company : " role"} and believe my ` +
    `background is a strong fit. I have solid experience in ${spec}, hands-on with ` +
    `${skills || "the technologies you listed"}. My resume is attached. I'd be glad to discuss further.\n\n` +
    `Best regards,\n${NAME}`,
  uk: (title, company, skills, spec) =>
    `Доброго дня!\n\nПобачив вашу вакансію "${title}"${company ? " у " + company : ""} і вважаю, що мій ` +
    `досвід добре підходить. Маю ґрунтовний досвід в ${spec}, практичний досвід із ` +
    `${skills || "переліченими технологіями"}. Додаю резюме. Буду радий обговорити деталі.\n\n` +
    `З повагою,\n${NAME}`,
  ru: (title, company, skills, spec) =>
    `Добрый день!\n\nУвидел вашу вакансию "${title}"${company ? " в " + company : ""} и считаю, что мой ` +
    `опыт хорошо подходит. Имею основательный опыт в ${spec}, практический опыт с ` +
    `${skills || "перечисленными технологиями"}. Прикладываю резюме. Буду рад обсудить детали.\n\n` +
    `С уважением,\n${NAME}`,
};
```

Update the call site in `buildApplication` (the `const cover = …` line):

```js
  const cover = llmCover || (COVER[lang] || COVER.en)(job.title, job.company, skills, coverPhrase(SKILLS_PROFILE, lang));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/application.test.mjs`
Expected: PASS — including the pre-existing template assertions (`I came across your "Senior AQA"` still matches because `profile.en` = the legacy phrase).

- [ ] **Step 6: Full suite + commit**

Run: `node --test test/`
Expected: all PASS.

```bash
git add skills.json lib/application.mjs test/application.test.mjs
git commit -m "feat: specialization phrase in fallback covers comes from skills.json profile block"
```

---

### Task 2: Neutral wording + developer preset + README

**Files:**
- Modify: `lib/draft.mjs:21,31,41` (three wording tokens)
- Create: `skills.developer.json.example`
- Modify: `README.md` (new section before "## Tuning relevance — `skills.json`"), `README.uk.md` (mirror before "## Налаштування релевантності — `skills.json`")

**Interfaces:**
- Consumes: the `profile` block shape `{ en, uk, ru }` from Task 1.
- Produces: docs + preset only; no code interfaces.

- [ ] **Step 1: Neutralize the clarifying-reply wording in `lib/draft.mjs`**

Three token replacements in the `maybe` templates (a question to a recruiter, not a profession identity — no config needed):
- line 21 (en): `automation scope` → `scope of work`
- line 31 (ru): `объём автоматизации` → `объём работ`
- line 41 (uk): `обсяг автоматизації` → `обсяг робіт`

- [ ] **Step 2: Create `skills.developer.json.example`**

```json
{
  "_comment": "Drop-in skills.json for a backend/full-stack TypeScript-Node developer. Activate with: cp skills.developer.json.example skills.json — then update the searches in jobs.config.json, resume.txt and RESUME_PATH (see README, 'Adapting to another profession').",
  "roles": [
    "software engineer", "software developer", "backend developer", "backend engineer",
    "full stack developer", "full stack engineer", "node.js developer", "typescript developer",
    "frontend developer", "web developer", "senior developer", "senior engineer",
    "розробник програмного забезпечення", "бекенд розробник", "фулстек розробник",
    "веб розробник", "інженер-програміст", "програміст",
    "разработчик программного обеспечения", "бэкенд разработчик", "фулстек разработчик",
    "веб разработчик", "инженер-программист", "программист"
  ],
  "skills": {
    "typescript": 5,
    "node.js": 5,
    "nodejs": 5,
    "javascript": 4,
    "react": 4,
    "rest": 4,
    "api": 3,
    "graphql": 3,
    "postgresql": 3,
    "sql": 3,
    "mongodb": 2,
    "redis": 2,
    "docker": 3,
    "kubernetes": 2,
    "aws": 3,
    "microservices": 4,
    "ci/cd": 3,
    "git": 1,
    "jest": 2,
    "express": 3,
    "nestjs": 3,
    "websocket": 2,
    "rabbitmq": 2,
    "kafka": 2
  },
  "_synonymsComment": "Cross-language equivalents for conceptual skills. A skill's weight counts ONCE if the key OR any synonym matches.",
  "synonyms": {
    "microservices": ["мікросервіси", "микросервисы"],
    "api": ["апі"]
  },
  "antiKeywords": {
    "wordpress": -3,
    "unpaid": -6,
    "internship": -3,
    "relocation required": -1,
    "on-site only": -1
  },
  "thresholds": {
    "_comment": "score >= relevant -> draft + 'attach resume'. score >= maybe -> draft flagged for your judgment. below maybe -> logged only, no draft.",
    "relevant": 8,
    "maybe": 4
  },
  "_profileComment": "How the FALLBACK cover letters describe your specialization, per language (LLM letters ignore this — they are grounded in resume.txt). Cyrillic phrases sit in genitive position — 'досвід в …' / 'опыт в …'.",
  "profile": {
    "en": "software development",
    "uk": "розробці програмного забезпечення",
    "ru": "разработке программного обеспечения"
  }
}
```

Verify it parses: `node -e "JSON.parse(require('fs').readFileSync('skills.developer.json.example','utf8')); console.log('ok')"`

- [ ] **Step 3: README.md — new section**

Insert immediately BEFORE the `## Tuning relevance — \`skills.json\`` heading:

```markdown
## Adapting to another profession

Nothing in the code knows you are a QA engineer — the profession lives
entirely in config. To hunt, say, developer jobs instead:

1. **Skill profile** — `cp skills.developer.json.example skills.json` (a
   ready TypeScript/Node preset), or edit your own `roles` / `skills` /
   `antiKeywords` / `profile`. The `profile` block is the specialization
   phrase the *fallback* cover letters use (LLM letters derive from your
   resume instead); Cyrillic values sit in genitive position ("досвід в …").
2. **Searches** — point `jobs.config.json` at the new field, e.g. DOU feed
   `https://jobs.dou.ua/vacancies/feeds/?category=Node.js`, Djinni
   `https://djinni.co/jobs/?primary_keyword=Node.js`, Jooble
   `{ "keywords": "node.js developer", "location": "remote" }`, LinkedIn
   `{ "keywords": "TypeScript Node.js developer", "location": "Ukraine", "remote": true }`.
3. **Resume** — replace `resume.txt` (drives LLM scoring and letters).
4. **Attachment** — update `RESUME_PATH` in `run.sh` / `run-jobs.sh`.
```

- [ ] **Step 4: README.uk.md — mirror**

Insert immediately BEFORE the `## Налаштування релевантності — \`skills.json\`` heading:

```markdown
## Адаптація під іншу професію

Код нічого не знає про QA — професія повністю живе в конфігурації. Щоб
шукати, наприклад, вакансії розробника:

1. **Профіль навичок** — `cp skills.developer.json.example skills.json`
   (готовий пресет TypeScript/Node) або відредагуйте власні `roles` /
   `skills` / `antiKeywords` / `profile`. Блок `profile` — це фраза
   спеціалізації для *резервних* супровідних листів (LLM-листи будуються з
   резюме); кириличні значення стоять у родовому відмінку ("досвід в …").
2. **Пошуки** — перенаправте `jobs.config.json` на нову сферу, напр. DOU-фід
   `https://jobs.dou.ua/vacancies/feeds/?category=Node.js`, Djinni
   `https://djinni.co/jobs/?primary_keyword=Node.js`, Jooble
   `{ "keywords": "node.js developer", "location": "remote" }`, LinkedIn
   `{ "keywords": "TypeScript Node.js developer", "location": "Ukraine", "remote": true }`.
3. **Резюме** — замініть `resume.txt` (керує LLM-оцінкою та листами).
4. **Вкладення** — оновіть `RESUME_PATH` у `run.sh` / `run-jobs.sh`.
```

- [ ] **Step 5: Verify + commit**

Run: `node --test test/` — all PASS (wording change touches no tested strings; `drafts` templates have no test).
Run: `node --check lib/draft.mjs` — parses.

```bash
git add lib/draft.mjs skills.developer.json.example README.md README.uk.md
git commit -m "feat: developer preset + profession-switch docs; neutral scope-of-work wording"
```
