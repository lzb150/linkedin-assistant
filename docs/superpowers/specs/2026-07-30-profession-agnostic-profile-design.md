# Profession-agnostic profile — design

Date: 2026-07-30
Status: approved

## Goal

The assistant is nearly profession-independent already: roles, skill weights,
anti-keywords and search queries all live in config (`skills.json`,
`jobs.config.json`), and the LLM letters derive from `resume.txt`. The only
profession baked into code is one phrase — "solid experience in test
automation" (en/uk/ru) — in the fallback cover templates
(`lib/application.mjs:14,19,24`) plus an "automation scope" wording in the
clarifying reply (`lib/draft.mjs`). Move the phrase into config, neutralize
the wording, and ship a developer preset so switching professions is a pure
config change.

Decisions made during brainstorming: ONE active profile at a time (no
multi-profession search); the user's own QA profile stays active — the
developer profile ships as an example preset.

## 1. `profile` block in `skills.json`

`skills.json` is already the profession profile, so the specialization phrase
lives there:

```json
"_profileComment": "How the fallback cover letters describe your specialization, per language. The LLM letters ignore this — they are grounded in resume.txt.",
"profile": {
  "en": "test automation",
  "uk": "автоматизації тестування",
  "ru": "автоматизации тестирования"
}
```

Grammar note (documented in the comment for uk/ru): the phrase is
interpolated in the genitive position — "досвід в …" / "опыт в …" — so the
Cyrillic values must fit that case (e.g. a developer preset uses
"розробці програмного забезпечення" / "разработке программного обеспечения").

## 2. `lib/application.mjs` reads the profile

Load `skills.json` the same way `lib/relevance.mjs` does (readFileSync at
module load). The three COVER templates interpolate the phrase:

- en: `I have solid experience in ${spec}, hands-on with …`
- uk: `Маю ґрунтовний досвід в ${spec}, практичний досвід із …`
- ru: `Имею основательный опыт в ${spec}, практический опыт с …`

Backward compatibility: when `profile` (or a language key) is absent, the
default is the CURRENT hard-coded phrase for that language — existing configs
produce byte-identical packages. This matches the repo's migration pattern
(legacy formats keep working silently).

## 3. `lib/draft.mjs` wording neutralized

The clarifying ("maybe") reply asks about "automation scope" /
"обсяг автоматизації" / "объём автоматизации". That is a question to a
recruiter, not a profession identity — reword to "scope of work" /
"обсяг робіт" / "объём работ". No config involved.

## 4. Developer preset — `skills.developer.json.example`

A complete, drop-in `skills.json` for a backend/full-stack TypeScript/Node
developer, following the repo's `*.example` convention: `roles` (developer
titles en/uk/ru), `skills` with weights (typescript/node/react/sql/docker/aws
tier), `antiKeywords`, `thresholds` and a `profile` block ("software
development" / "розробці програмного забезпечення" / "разработке программного
обеспечения"). Copy over `skills.json` to activate.

## 5. README section — "Adapting to another profession" (EN + UK)

A short section stating the principle (no profession in code) and the
four-step switch:

1. `cp skills.developer.json.example skills.json` (or edit your own roles /
   skills / antiKeywords / profile)
2. Point the searches in `jobs.config.json` at the new field — with a worked
   developer example for each source (DOU category feed, Djinni
   `primary_keyword=JavaScript` / `Node.js`, Jooble keywords, LinkedIn
   searches)
3. Replace `resume.txt` (drives LLM scoring + letters)
4. Update `RESUME_PATH` in the run wrappers

## Error handling

- Missing/invalid `profile` block → hard-coded per-language defaults (current
  phrases); never throws.
- `skills.json` unreadable → `lib/relevance.mjs` already throws at startup
  today; `application.mjs` inherits the same behavior (no new failure mode).

## Testing

`lib/application.mjs` exports a small pure helper
`coverPhrase(profile, lang)` that resolves the phrase with per-language
defaults; the templates call it. Extend `test/application.test.mjs`:

- `coverPhrase` unit tests: present key → its value; missing language key,
  empty block, and `undefined` block → the legacy phrase for that language
  (the backward-compat regression guard).
- Integration path: build an en package and assert the cover note contains
  the phrase from the repo's real `skills.json` `profile.en` (read the file
  in the test instead of duplicating the string), proving templates actually
  route through the profile.

## Out of scope

- Multi-profession simultaneous search (explicitly rejected).
- Rewriting the user's active QA config.
- Any change to scoring, sources, LLM prompts, dashboard — already
  profession-independent.

## Implementation order

1. `coverPhrase` helper + profile block + template interpolation + tests
2. `draft.mjs` wording
3. `skills.developer.json.example` + README sections (EN + UK)
