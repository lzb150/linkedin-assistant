# Cross-Language Relevance Scoring — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** Make `lib/relevance.mjs` score Ukrainian- and Russian-worded vacancies
correctly. Today only English (and Latin tech terms) match; UA/RU job text scores
near zero, so real automation roles on DOU/Djinni are missed.

## Problem (evidence)

`scoreMessage` matches configured terms as whole words via a regex over the text.
Roles and conceptual skills are English-only, so Cyrillic-worded jobs miss them:

| Score | Verdict | Role | Skills | Case |
|------:|---------|------|-------:|------|
| 13 | relevant | — | 3 | UA, role in words + Latin tech terms |
| 0 | ignore | — | 0 | UA, no Latin terms |
| 0 | ignore | — | 0 | RU, in words |
| 27 | relevant | qa automation | 5 | EN baseline |

The 13-point UA case has `role = —`, so in `jobs.mjs` (`requireRole=true`,
`minScore=25`) it is **rejected** despite being a strong match. The two
fully-worded UA/RU automation roles score 0. DOU and Djinni are predominantly
Ukrainian boards, so this is a core defect.

Out of scope (chosen): score saturation for keyword-stuffed text, and salary /
seniority extraction. This spec is cross-language only.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Where synonyms live | `skills.json` (already user-edited) |
| 2 | Roles cross-language | Add UA/RU phrasings to the flat `roles` array (matched once → +6) |
| 3 | Skills cross-language | New `synonyms` block (concept → equivalents); weight counted once if the key OR any synonym matches (no double-count) |
| 4 | Morphology | Light algorithmic stemming for Cyrillic (`stemCyrillic`), conservative |
| 5 | English matching | Unchanged — `mentions()` still handles ASCII (`c#`, `ci/cd`, word boundaries) |
| 6 | Defaults | Seed `roles` (UA/RU) and `synonyms` for key concepts so it works out of the box |

## Architecture

### 1. `skills.json` schema (backward compatible)

- `roles` stays a flat array; append UA/RU forms, e.g.
  `"інженер з автоматизації тестування"`, `"автоматизатор"`,
  `"инженер по автоматизации тестирования"`. First match wins, counts once.
- New optional `synonyms` map (concept key from `skills` → list of equivalents):

```json
"skills": { "test automation": 5, "api testing": 4 },
"synonyms": {
  "test automation": ["автоматизація тестування", "автоматизоване тестування", "автотест", "автоматизация тестирования"],
  "api testing":     ["тестування api", "тестирование api"]
}
```

Latin tech terms (`playwright`, `typescript`, `c#`, `ci/cd`) get no synonyms —
they appear in Latin in UA/RU text and match as today. A missing `synonyms` block
behaves exactly like the current scorer.

### 2. `lib/relevance.mjs`

- `stemCyrillic(word)` — lower-cases and strips common UA/RU **inflectional**
  endings (declension/conjugation), conservatively: only when the token is
  Cyrillic and the resulting stem stays above a minimum length (≥4 Cyrillic
  chars) to avoid over-stemming short words. Returns the stem.
- `mentionsStem(haystack, phrase)` — stem-tolerant match used for **Cyrillic**
  phrases: each word becomes `escape(stem) + "[Cyrillic]*"`, words joined by
  `\s+`, with a left word boundary. The trailing `[Cyrillic]*` absorbs the
  haystack word's ending, so only the configured term is stemmed (the haystack
  is not retokenized). A phrase with no Cyrillic falls back to `mentions()`.
- `conceptMatches(hay, key, synonyms)` — true if `mentionsStem`/`mentions`
  matches the key OR any of its synonyms. Used so a concept's weight is added
  **once**.
- `scoreMessage` changes:
  - Role loop: unchanged logic, but matching goes through `mentionsStem` (UA/RU
    role forms now hit). Still `+6` once on first match.
  - Skill loop: for each `[skill, weight]`, add `weight` once if
    `conceptMatches(hay, skill, profile.synonyms?.[skill])`.
  - Anti-keywords: unchanged (English phrases); routed through the same matcher
    so a Cyrillic anti-keyword would also work if added later.

> Stemming closes **declension** (`автоматизаці-я/-ї/-ю`). It does **not** merge
> different word-formations (`автоматиза-ція` vs `автоматизо-ване`); list both in
> `synonyms`. Stemming handles cases, synonyms handle derivation.

## Tests — `test/relevance.test.mjs` (`node --test`)

- `stemCyrillic`: UA/RU declensions of a word reduce to one stem; short words are
  not over-stemmed.
- `mentionsStem`: `"автоматизації"` matches the term `"автоматизація"` (via stem);
  Latin matching is untouched; `c#` and `ci/cd` remain intact.
- `scoreMessage`: the four evidence cases above — UA/RU role-worded vacancies now
  get a role match and clear `jobs.mjs`'s `minScore` (25); the EN baseline is
  unchanged (no regression); **no double-count** when both the English key and a
  UA synonym appear in the same text.

## Affected files

- `lib/relevance.mjs` — stemmer, Cyrillic matcher, synonym grouping
- `skills.json` — UA/RU roles + `synonyms` block (seeded defaults)
- `test/relevance.test.mjs` (new)

## Out of scope (YAGNI)

- Score saturation / normalization.
- Salary and seniority extraction.
- Third-party NLP or stemming libraries.
- Any change to English-term matching behavior.
