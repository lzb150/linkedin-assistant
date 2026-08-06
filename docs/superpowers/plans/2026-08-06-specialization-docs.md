# Specialization Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `docs/specialization.md` — a guide from a job title (e.g. "senior fullstack developer") to a working config — with cross-links from README.md and README.uk.md.

**Architecture:** Docs-only change, three files. The guide is task-oriented ("from a job title to config") with Senior Fullstack Developer as the running example. Spec: `docs/superpowers/specs/2026-08-06-specialization-docs-design.md`.

**Tech Stack:** Markdown. No code, config, or test changes.

## Global Constraints

- Repo: `/Users/eugenelazeba/linkedin-assistant`.
- Docs in English; only README.uk.md is Ukrainian (repo rule).
- Facts the guide must state correctly: global `minScore` 25, Jooble override 18; role bonus +6; `maxSkills` default 8; `thresholds` relevant 8 / maybe 4; `excludeTitle` is whole-word, title-only, pre-scoring; Cyrillic matching is stem-based; `resume.txt`/`run.sh`/`run-jobs.sh` are gitignored; `profile.uk`/`.ru` sit in genitive position.

---

### Task 1: Create `docs/specialization.md`

**Files:**
- Create: `docs/specialization.md`

**Interfaces:**
- Produces: the anchor `docs/specialization.md` that Tasks 2 and 3 link to.

- [ ] **Step 1: Write the file with exactly this content**

````markdown
# Specifying your specialization

How to turn a job title like **Senior Fullstack Developer** into config this
assistant can hunt with. Nothing in the code knows your profession — it lives
in four places.

## Where your specialization lives

| File | What it holds | Committed? |
|------|---------------|------------|
| `skills.json` | Scoring profile: `roles`, `skills`, `synonyms`, `antiKeywords`, `profile` | yes |
| `jobs.config.json` | Where to search: per-source feeds and queries | yes |
| `resume.txt` | Plain-text resume — grounds LLM re-scoring and cover letters | no (gitignored) |
| `run.sh` / `run-jobs.sh` | `RESUME_PATH` — the PDF/DOCX attached to drafts | no (gitignored) |

## From a job title to config

Running example: **Senior Fullstack Developer** (TypeScript / Node.js / React).

### 1. Roles — titles you'd accept

List every title variant in `skills.json` → `roles`, lowercase. Matching is
substring-based with word boundaries, so `"fullstack developer"` already
matches "Senior Fullstack Developer" — no separate entry per seniority level.
Add Ukrainian/Russian variants in nominative case; Cyrillic matching is
stem-based (`lib/relevance.mjs`), so `"фулстек розробник"` also matches
"фулстек розробника" in postings.

A matched role adds a **+6** bonus, and with `requireRole: true` in
`jobs.config.json` postings whose text matches no role are skipped entirely.

```json
"roles": [
  "fullstack developer", "full stack developer", "fullstack engineer", "full stack engineer",
  "software engineer", "typescript developer", "node.js developer", "react developer",
  "фулстек розробник", "розробник програмного забезпечення", "програміст",
  "фулстек разработчик", "разработчик программного обеспечения", "программист"
]
```

### 2. Skills — weighted keywords

Derive these from your resume, not from job ads. Weight scale: **5** = core
(you'd be hired for these), **3–4** = solid secondary, **1–2** = nice-to-have.
Only the `maxSkills` (default 8) highest-weight matches count toward the
score, so giving everything a 5 doesn't help — it just blurs ranking.

```json
"skills": {
  "typescript": 5, "node.js": 5, "react": 5,
  "next.js": 4, "nestjs": 4, "rest": 4, "microservices": 4,
  "postgresql": 3, "graphql": 3, "docker": 3, "ci/cd": 3, "aws": 3,
  "redis": 2, "jest": 2, "kubernetes": 2, "git": 1
}
```

Add `synonyms` for concept skills that appear translated in UA/RU postings
(`"microservices": ["мікросервіси", "микросервисы"]`). Latin tech terms
(typescript, react) need none — they stay Latin in Cyrillic text.

### 3. antiKeywords — deal-breakers

Phrases that *lower* the score. Use them for stacks or conditions you won't
take, not for mild preferences:

```json
"antiKeywords": {
  "wordpress": -3, "unpaid": -6, "internship": -3,
  "relocation required": -1, "on-site only": -1
}
```

### 4. profile — the fallback letter phrase

Per-language specialization phrase used only by *fallback* cover letters
(LLM letters are grounded in `resume.txt` instead). Cyrillic values sit in
genitive position — they complete "досвід в …" / "опыт в …":

```json
"profile": {
  "en": "full-stack development (TypeScript, Node.js, React)",
  "uk": "фулстек розробці (TypeScript, Node.js, React)",
  "ru": "фулстек-разработке (TypeScript, Node.js, React)"
}
```

### 5. Searches — `jobs.config.json`

Point every enabled source at the new field. Copy real URLs from your
browser's filters — that keeps parameters valid:

```json
"dou":      { "feeds": ["https://jobs.dou.ua/vacancies/feeds/?search=fullstack"] },
"djinni":   { "searches": ["https://djinni.co/jobs/?primary_keyword=Fullstack"] },
"jooble":   { "searches": [{ "keywords": "fullstack developer", "location": "remote" }] },
"linkedin": { "searches": [{ "keywords": "Fullstack TypeScript React", "location": "Ukraine", "remote": true }] }
```

The global `minScore` (25) gates cold applications; Jooble has a per-source
override (18) because its API returns short snippets that score lower.

### 6. Resume

Replace `resume.txt` with your plain-text resume (it drives LLM re-scoring
and letters), and point `RESUME_PATH` in `run.sh` / `run-jobs.sh` at the
PDF/DOCX to attach. All three files are gitignored.

## Seniority

- `excludeTitle` in `jobs.config.json` drops titles containing
  `junior` / `intern` / `internship` / `trainee` before scoring —
  whole-word, title-only.
- There is no "senior-only" positive filter: the score is skill-based, and
  senior titles already match your role entries by substring.
- Want senior+ roles only? Keep `excludeTitle` aggressive and raise `minScore`.

## Starting preset

`skills.developer.json.example` is a ready backend/full-stack TS-Node
profile: `cp skills.developer.json.example skills.json`, then adjust weights
to your resume.

## Checklist

1. `skills.json` — roles, skills, synonyms, antiKeywords, profile updated.
2. `jobs.config.json` — searches repointed; `excludeTitle` still fits.
3. `resume.txt` replaced; `RESUME_PATH` updated in `run.sh` / `run-jobs.sh`.
4. ⚠️ `test/relevance.test.mjs` — the `scoreMessage` tests pin the active
   profile's scores; update them **in the same commit** as `skills.json`.
5. Verify: `node --test test/`, then one `node jobs.mjs` run — the newest
   file in `applications/` should read like your new specialization.
````

- [ ] **Step 2: Verify the embedded JSON snippets parse**

Run:
```bash
cd /Users/eugenelazeba/linkedin-assistant && node -e '
const fs = require("fs");
const md = fs.readFileSync("docs/specialization.md", "utf8");
const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
blocks.forEach((b, i) => JSON.parse("{" + b.replace(/,\s*$/, "") + "}"));
console.log(`OK: ${blocks.length} snippets parse`);
'
```
Expected: `OK: 5 snippets parse` (each fenced block is a JSON fragment; wrapping in `{}` makes it parseable).

- [ ] **Step 3: Commit**

```bash
git add docs/specialization.md
git commit -m "docs: add guide for specifying your specialization"
```

---

### Task 2: Link the guide from README.md

**Files:**
- Modify: `README.md:255` (end of the "Adapting to another profession" list)

**Interfaces:**
- Consumes: `docs/specialization.md` from Task 1.

- [ ] **Step 1: Append the link line**

After the list item `4. **Attachment** — update RESUME_PATH in run.sh / run-jobs.sh.` (line 255), insert a blank line and:

```markdown
The full walkthrough — from a job title like "Senior Fullstack Developer" to a
working config, including seniority handling and the profile-coupled tests —
lives in [docs/specialization.md](docs/specialization.md).
```

- [ ] **Step 2: Verify the link target exists**

Run: `test -f docs/specialization.md && grep -c "docs/specialization.md" README.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: link specialization guide from README"
```

---

### Task 3: Mirror a short subsection in README.uk.md

**Files:**
- Modify: `README.uk.md:268` (end of the "Адаптація під іншу професію" list)

**Interfaces:**
- Consumes: `docs/specialization.md` from Task 1.

- [ ] **Step 1: Append the Ukrainian pointer**

After the list item `4. **Вкладення** — оновіть RESUME_PATH у run.sh / run-jobs.sh.` (line 268), insert a blank line and:

```markdown
Повний покроковий гайд — від назви посади (напр. «Senior Fullstack Developer»)
до робочого конфіга, включно з сеньйорністю та тестами, прив'язаними до
профілю — у [docs/specialization.md](docs/specialization.md) (англійською).
```

- [ ] **Step 2: Verify**

Run: `grep -c "docs/specialization.md" README.uk.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add README.uk.md
git commit -m "docs: link specialization guide from Ukrainian README"
```

---

## Self-Review

- **Spec coverage:** guide (Task 1), README link (Task 2), UK mirror (Task 3) — all spec deliverables covered; non-goals (no presets, no code) respected.
- **Placeholders:** none — full guide text embedded in Task 1.
- **Fact consistency:** minScore 25/18, +6 role bonus, maxSkills 8, gitignored files, genitive profile phrases — all match the spec's constraints section and the actual configs.
