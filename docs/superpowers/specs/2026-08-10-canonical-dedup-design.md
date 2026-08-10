# Canonical-Key Deduplication — Design

**Goal:** Cut duplicate vacancies that today survive de-dup because boards reword
titles (req-number suffixes, token order) or because the same vacancy resurfaces
on another board in a later run.

**Evidence (2026-08-10 scan of 551 packages):** 201 same-company near-duplicate
title pairs at Jaccard ≥ 0.5. Real duplicates look like DOU "Senior Automation QA
Engineer (3310)" vs LinkedIn "Senior Automation QA Engineer"; false-merge traps
look like Ciklum's "Lead … (3282)" vs "Senior … (3310)" (distinct reqs and
seniority). Deterministic canonicalization is chosen over fuzzy thresholds: the
trap pairs score 0.5–0.67 Jaccard, too close to real dups for a safe cutoff.

## Decisions (user-confirmed)

1. **Scope:** both same-run cross-source merging and cross-run checks against
   already-created application packages.
2. **Req-number rule:** same canonical title at the same company — records from
   the *same* source stay separate (the board itself distinguishes the reqs);
   records from *different* sources merge.

## Components

### 1. `canonicalKey(job)` in `lib/dedup.mjs`

Pipeline: existing `basicNormalize` → split into tokens → drop pure-numeric
tokens of ≥ 3 digits (req IDs like 3282, 5546; "Engineer 2" keeps its level
digit) → expand aliases (`aqa` → `automation qa`; extendable map) → sort
tokens → join. Key = `normalizeCompany(company)::sortedTokens`.

Seniority tokens (senior/middle/lead/junior) are **kept** — different seniority
never merges. `identityKey` is replaced by `canonicalKey` everywhere (it has no
other callers than dedupeJobs/tests).

### 2. Same-run merge rule in `dedupeJobs`

Group by `canonicalKey`. Within a group:
- If every record comes from a distinct source → current behavior (keep the
  longest-`text` record, others become `altLinks`).
- If some source contributed 2+ records → keep **all** records of the source
  with the most entries (tie: the source holding the longest text); fold the
  other sources' records into those keepers as `altLinks`, round-robin. The
  group's longest `text` is copied onto its keeper so scoring quality never
  degrades.

### 3. Cross-run check in `jobs.mjs`

Before writing a new package: build the canonical-key set of existing
`applications/*.md` (company/title/source live in frontmatter; ~550 files, read
once per run). If the new job's key matches an existing package →
- do **not** create a new package;
- append the new `source|url` pair to the existing package's `alt_links`
  frontmatter line (create the line if absent) unless that url is already there;
- log `· dup-of-existing: <file>` and mark the url as seen.

Package status (`applied`, `answered`, …) is untouched — the point is not to
re-apply to a vacancy already tracked.

### 4. Tests (`test/dedup.test.mjs` extension + jobs-flow coverage)

Dataset-derived cases:
- DOU "Senior Automation QA Engineer (3310)" + LinkedIn "Senior Automation QA
  Engineer" → one record, one altLink.
- DOU "(3310)" + DOU "(3650)" same title → two records.
- Lead vs Senior same company → never merge.
- "Automation QA" vs "QA Automation" token order → merge.
- "AQA Engineer" vs "Automation QA Engineer" via alias → merge.
- Cross-run: existing package frontmatter + matching new job → no new package,
  alt_links appended (pure-function test on the helper).

## Non-goals

- No fuzzy/threshold matching, no LLM adjudication.
- Strong rewordings ("QA Engineer" vs "Automation QA Engineer with Python")
  stay unmerged by design — zero false merges beats full recall.
- No retro-clean of the existing 551 packages (cross-run check prevents new
  dups going forward; old ones age out via prune).

## Error handling

Frontmatter parse failures on an existing package → skip that file (log once),
never crash the run. The alt_links append rewrites only the frontmatter line,
preserving the rest of the file byte-for-byte.
