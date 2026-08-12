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
| `run.sh` / `run-jobs.sh` | `RESUME_PATH` — the PDF/DOCX attached to drafts; `CANDIDATE_NAME` — the signature on cover letters | no (gitignored) |

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

Point **every** enabled source at the new field — there are six (`dou`,
`djinni`, `jooble`, `workua`, `robota`, `linkedin`); a source left on the old
searches keeps fetching the old profession. Copy real URLs from your
browser's filters — that keeps parameters valid:

```json
"dou":      { "feeds": ["https://jobs.dou.ua/vacancies/feeds/?search=fullstack"] },
"djinni":   { "searches": ["https://djinni.co/jobs/?primary_keyword=Fullstack"] },
"jooble":   { "searches": [{ "keywords": "fullstack developer", "location": "віддалено" }] },
"workua":   { "searches": ["https://www.work.ua/jobs-fullstack/"] },
"robota":   { "searches": ["https://robota.ua/zapros/fullstack/ukraine"] },
"linkedin": { "searches": [{ "keywords": "Fullstack TypeScript React", "location": "Ukraine", "remote": true }] }
```

Jooble runs on the Ukrainian market (`ua.jooble.org`), so `location` takes
`""` (all of Ukraine), `"віддалено"` (remote only), or a city name — an
English `"remote"` is not a location it recognizes.

The global `minScore` (25) gates cold applications; Jooble has a per-source
override (18) because its API returns short snippets that score lower.

### 6. Resume

Replace `resume.txt` with your plain-text resume (it drives LLM re-scoring
and letters), and in `run.sh` / `run-jobs.sh` point `RESUME_PATH` at the
PDF/DOCX to attach and set `CANDIDATE_NAME` to the name that signs your
cover letters. All three files are gitignored.

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
2. `jobs.config.json` — searches repointed for **all six** sources;
   `excludeTitle` still fits.
3. `resume.txt` replaced; `RESUME_PATH` and `CANDIDATE_NAME` updated in
   `run.sh` / `run-jobs.sh`.
4. Verify: `node --test test/` (the suite runs on a frozen fixture profile,
   so it stays green regardless of your `skills.json`), then one
   `node jobs.mjs` run — the newest file in `applications/` should read
   like your new specialization.
