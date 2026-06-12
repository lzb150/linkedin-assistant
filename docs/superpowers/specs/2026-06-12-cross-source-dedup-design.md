# Cross-Source Job Deduplication — Design

**Date:** 2026-06-12
**Status:** Approved
**Scope:** Collapse the same vacancy arriving from multiple sources (DOU, Djinni,
Jooble, LinkedIn) into a single entry, so the dashboard and application packages
are free of cross-source duplicates.

## Problem

Each source returns jobs as `{ source, title, company, url, location, text }`.
De-duplication today exists only *within* Djinni (by URL), and the global
`jobs-seen.json` set is also keyed by URL. The same vacancy posted on several
boards has a different URL per board, so:

- Within one run, the same job from two sources is scored and written twice.
- Across runs, a job already handled from source A re-appears from source B with
  a new URL and is written again.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Identity key (what is "the same job") | `normalize(company) + normalize(title)`, exact match (no fuzzy) |
| 2 | Which duplicate to keep | The record with the **longest `text`** (richest description → most accurate scoring); alternative source links are preserved on the kept record |
| 3 | `jobs-seen.json` keying | Switch to **identity keys** (same `normalize(company)+normalize(title)`) for both in-run and cross-run dedup |
| 4 | Legacy `jobs-seen.json` migration | **Reset to empty** when the old URL-based format is detected |
| 5 | Tests | Yes — extract normalization/dedup into `lib/dedup.mjs` and unit-test it |

`normalizeTitle` is intentionally **light** (case, punctuation, whitespace only).
Parenthetical qualifiers like `(Playwright)` are kept, so distinct roles at the
same company (e.g. `Manual QA` vs `QA Automation`) do not merge.

## Architecture

### 1. New module `lib/dedup.mjs` (pure functions, no network)

```
normalizeCompany(s)  → lower-case; strip punctuation; strip company suffixes
                       (llc, inc, ltd, gmbh, corp, co, group, "ооо", "тов", …);
                       collapse whitespace
normalizeTitle(s)    → lower-case; strip punctuation; collapse whitespace
identityKey(job)     → `${normalizeCompany(job.company)}::${normalizeTitle(job.title)}`
dedupeJobs(jobs)     → collapse duplicates by identityKey:
                        • keep the record with the longest `job.text`
                        • attach `altLinks: [{ source, url }, …]` for every
                          dropped duplicate (excluding the kept record itself)
                        • return { deduped: [...], mergedCount }
```

### 2. Integration in `jobs.mjs`

After the `Total jobs gathered` log:

```js
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);
```

In the scoring loop, replace URL-based seen checks with identity keys:

- `seen.has(job.url)`  → `seen.has(identityKey(job))`
- `seen.add(job.url)`  → `seen.add(identityKey(job))`

### 3. `jobs-seen.json` migration

`loadSeen()`: if any entry looks like a URL (`startsWith("http")`), treat the
file as the legacy format and start from an empty set. Going forward only
identity keys are written. Old history is not converted (per decision #4); it is
not needed because the current run repopulates `seen` from the jobs it processes.

### 4. Surfacing alternative links

- `buildApplication(job, scored)` — when `job.altLinks` is present:
  - frontmatter: `alt_links: source|url, source|url`
  - body: an `## Also listed on` section listing each alternative link.
- `dashboard.mjs` — read `alt_links` from the frontmatter and render small
  link badges on the card ("also on: LinkedIn, DOU").

### 5. Tests `test/dedup.test.mjs` (`node --test`)

- `normalizeCompany`: suffix stripping (`SoftServe LLC` == `SoftServe`), case,
  punctuation.
- `normalizeTitle`: case / punctuation / whitespace; `(Playwright)` is **not**
  lost (distinct roles do not merge).
- `dedupeJobs`: duplicates across sources collapse; the longest `text` survives;
  `altLinks` collects the rest; distinct roles at one company do **not** merge.

## Out of scope (YAGNI)

- No fuzzy title matching.
- No changes to scoring logic, cover-note format, or the source fetchers.
- No cross-run persistence of `altLinks` beyond the current application package.

## Affected files

- `lib/dedup.mjs` (new)
- `jobs.mjs`
- `lib/application.mjs`
- `dashboard.mjs`
- `test/dedup.test.mjs` (new)
