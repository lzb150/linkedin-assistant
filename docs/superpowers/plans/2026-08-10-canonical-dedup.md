# Canonical-Key Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge reworded cross-source duplicates in-run and stop duplicate packages across runs, per `docs/superpowers/specs/2026-08-10-canonical-dedup-design.md`.

**Architecture:** `canonicalKey` joins `identityKey` in `lib/dedup.mjs` (identityKey stays for seen/dashboard/prune). `dedupeJobs` regroups by canonical key with a per-source keep rule. `jobs.mjs` gains a package index (canonical key → {file, source}) consulted in the scoring loop; hits from another source append to the existing package's `alt_links` via a new `appendAltLink` in `lib/application.mjs`.

**Tech Stack:** Node ESM, `node:test`, no new dependencies.

## Global Constraints

- Decision 2: same canonical title at same company — same-source records stay separate, cross-source merge.
- `identityKey` callers (seen set, dashboard collapse, prune) are untouched.
- alt_links append rewrites only the frontmatter line; file body byte-identical.
- Frontmatter parse failures skip the file, never crash the run.

---

### Task 1: `canonicalKey` + per-source `dedupeJobs` (lib/dedup.mjs, tests)

**Files:** Modify `lib/dedup.mjs`, `test/dedup.test.mjs`.

**Interfaces:** Produces `canonicalKey(job) → string` (exported); `dedupeJobs` keeps its `{deduped, mergedCount}` signature.

- [ ] Add `canonicalKey`: `normalizeTitle` → tokens → drop `/^\d{3,}$/` req IDs → expand `TITLE_ALIASES` (`aqa → automation qa`) → unique → sort → `` `${normalizeCompany(company)}::${tokens.join(" ")}` ``.
- [ ] Rewrite `dedupeJobs` grouping on `canonicalKey`; in multi-record groups pick the source with most records (tie → the source holding the group's longest text) as keepers, fold other sources' records into keepers round-robin as `altLinks`, copy the group's longest `text` onto the richest keeper; single-per-source groups behave exactly as before.
- [ ] Tests (dataset-derived): DOU "(3310)"+LinkedIn merge → 1 record 1 altLink; DOU "(3310)"+DOU "(3650)" → 2 records; Lead vs Senior never merge; "Automation QA"↔"QA Automation" merge; "AQA Engineer"↔"Automation QA Engineer" merge; old altLinks/longest-text semantics regression.
- [ ] `node --test test/dedup.test.mjs` green; commit `feat: canonical-key dedupe with per-source keep rule`.

### Task 2: cross-run package check (jobs.mjs, lib/application.mjs, tests)

**Files:** Modify `jobs.mjs` (imports + index + loop check), `lib/application.mjs` (`appendAltLink`), `test/application.test.mjs`.

**Interfaces:** Consumes `canonicalKey` from Task 1. Produces `appendAltLink(file, source, url) → boolean`.

- [ ] `appendAltLink`: read file, bail `false` if no frontmatter or url already present; append `source|url` to the `alt_links:` line or insert the line before the closing `---`; write; return `true`.
- [ ] In `jobs.mjs`, before loop 5a build `packageIndex` from `applications/*.md` via `parseFrontmatter` (skip unparsable); in the loop after the `seen` check: index hit with `existing.source !== job.source` → `appendAltLink`, log `· dup-of-existing`, `recordOutcome(summary, job.source, "seen")`, `seen.add(id)`, `continue`.
- [ ] Tests: appendAltLink creates line / appends / dedups url / returns false without frontmatter (temp files).
- [ ] Full suite + one manual `node jobs.mjs` run; commit `feat: cross-run package dedup via canonical key`.

### Task 3: PR

- [ ] `node --test test/` green, push branch, `gh pr create`, ask user before merge.

## Self-Review

Spec §1→Task 1, §2→Task 1, §3→Task 2, tests §4 split across both. No placeholders; canonicalKey signature consistent across tasks; decision-2 rule encoded in both the grouping and the `existing.source !== job.source` guard.
