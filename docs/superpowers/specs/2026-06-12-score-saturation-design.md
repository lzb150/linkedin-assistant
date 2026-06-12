# Score Saturation (Top-N Skill Cap) — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** Cap how much matched skills can contribute to a vacancy's relevance
score, so keyword-stuffed postings stop outscoring genuinely strong matches.

## Problem (evidence)

`scoreMessage` sums the weight of every matched skill. A posting that lists the
whole tech landscape accumulates points linearly:

| Case | Score today | Matched skills |
|------|------------:|---------------:|
| EN baseline (good real match) | 27 | 5 |
| Rich real vacancy | 33 | 9 |
| Keyword-stuffed posting | 72 | 20 |

The stuffed posting (72) dwarfs real matches, distorting the dashboard ordering
and the cold-application gate's signal-to-noise.

## Decision: top-N cap (N = 8, configurable)

Only the **top 8 matched skill weights** (sorted descending) count toward the
score. Mechanisms compared on the three cases above:

| Case | now | top-6 | **top-8** | diminishing (1/√rank) |
|------|----:|------:|----------:|----------------------:|
| EN baseline | 27 | 27 | **27** | 20 ⚠️ breaks `minScore 25` |
| Rich real vacancy | 33 | 24 ⚠️ rejected | **30** | 19 ⚠️ |
| Keyword-stuffed | 72 | 32 | **40** | 34 |

- Diminishing returns breaks the calibration of every threshold
  (`minScore 25`, `jooble.minScore 18`, `thresholds.relevant/maybe`) — too much
  blast radius.
- top-6 rejects a genuinely rich real vacancy (33 → 24 < 25).
- **top-8** leaves the baseline untouched, keeps real matches above the gate,
  and halves the stuffed score. No threshold retuning needed.

## Architecture

### 1. `skills.json`

New optional top-level key with an explanatory comment:

```json
"_maxSkillsComment": "Only the N highest-weight matched skills count toward the score — guards against keyword-stuffed postings outscoring real matches. Role bonus and antiKeywords are not capped.",
"maxSkills": 8
```

Missing key → code default of 8 (existing profiles keep working).

### 2. `lib/relevance.mjs` — `scoreMessage`

The skill loop stops summing inline. Instead it:

1. Collects matched `[skill, weight]` pairs (matching logic unchanged —
   `conceptMatches` with synonyms).
2. `matchedSkills` still lists **all** matches (package output unchanged).
3. The score adds the sum of the **top `maxSkills` weights** (sort weights
   descending, slice `profile.maxSkills ?? 8`, sum).

Role bonus (+6) and anti-keywords are **not** capped — the cap applies only to
positive skill contributions.

### 3. Tests — `test/relevance.test.mjs`

- EN baseline stays exactly 27 (existing test keeps passing — no regression).
- A rich real vacancy (9 matched skills) still scores ≥ 25 (not rejected by the
  cold-application gate).
- Keyword-stuffed case: score equals role bonus + sum of its top-8 weights
  (markedly below today's 72), while `matchedSkills` still reports every match.
- The cap honors `maxSkills` from the profile (assertions are derived from the
  formula against the current profile, default 8).

## Affected files

- `lib/relevance.mjs` — skill loop: collect, then cap-sum
- `skills.json` — `maxSkills` + comment
- `test/relevance.test.mjs` — saturation tests

## Out of scope (YAGNI)

- No changes to `minScore`, `jooble.minScore`, or `thresholds` — top-8 was
  chosen so they remain valid.
- No diminishing-returns scoring.
- No salary/seniority extraction.
- No change to role or anti-keyword scoring.
