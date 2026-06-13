# Run Summary (Per-Source Digest) — Design

**Date:** 2026-06-13
**Status:** Approved
**Scope:** At the end of a `jobs.mjs` run, print a per-source summary table to
the console and always send a short macOS notification with the run's outcome,
so scraper health and the day's catch are visible without reading the full log.

## Problem (evidence)

`jobs.mjs` collects every vacancy into one flat array and logs only two global
counters (`considered`, `written`). There is no per-source breakdown, so:

- A silently broken scraper (a source returns 0 because its markup changed or it
  got blocked) is invisible — the run still "succeeds".
- The macOS notification fires **only** when `written > 0`, so a run that found
  nothing gives no feedback at all.

## Decision: single-run digest, console table + always-on notification

- **No history / trend.** The digest summarizes the current run only. No new
  state files.
- **Console table** printed at the end, before the dashboard refresh.
- **Notification fires on every run** (not only when something is written), with
  a one-line outcome.
- **Top score** is reported only among **written** matches; if nothing was
  written, the line is omitted (and the notification says "No new matches").

## Architecture

### 1. `lib/run-summary.mjs` (new — pure, no side effects)

A small accumulator plus two formatters. Pure functions so it is fully unit
testable without running scrapers.

```js
newSummary()                    // → { sources: {}, merged: 0, top: null }
recordFound(s, source, n)       // raw count from a source fetch (pre-dedup)
recordOutcome(s, source, kind)  // kind: 'excluded' | 'seen' | 'low' | 'written' (post-dedup)
recordMerged(s, n)              // global cross-source duplicates collapsed
recordTop(s, score, label)      // keep the max-scoring WRITTEN match
formatTable(s)                  // → multi-line string for the console
formatNotification(s)           // → short one-line string for notify()
```

**Source bucket shape:** each source key holds
`{ found, excluded, seen, low, written }`, all integers starting at 0.
`recordFound`/`recordOutcome` lazily create the bucket for a source the first
time it is seen, so source name strings (`dou`, `djinni`, `jooble`, `linkedin`)
need not be pre-registered.

### 2. What is counted

- **found** — the raw length returned by each `fetch*` call, recorded **before**
  dedup. This is the scraper-health signal (e.g. `dou found 0` means DOU broke).
- **excluded / seen / low / written** — mutually exclusive outcomes of the
  scoring loop, recorded **after** dedup, attributed to the surviving record's
  `job.source`. They sum to the post-dedup count for that source.
- **merged** — global count of cross-source duplicates collapsed, taken from
  `dedupeJobs`'s existing `mergedCount`. Shown as one line, and it accounts for
  why per-source `found` (raw) can exceed `excluded+seen+low+written`.
- **top** — the highest-scoring **written** match this run, as
  `{ score, label }`. `null` when nothing was written.

### 3. Console output (`formatTable`)

```
Run summary 2026-06-13 10:22
            found  excl  seen  low  NEW
  dou         12     1     8    0    3
  djinni       8     0     6    0    2
  jooble       5     0     5    0    0
  linkedin     4     0     4    0    0
  merged 2 cross-source duplicate(s)
  top score: 42 (Senior AQA @ Acme)
```

- One row per source that appears in `summary.sources`, in insertion order.
- The `merged` line is shown only when `merged > 0`.
- The `top score` line is shown only when `summary.top` is set (i.e. at least
  one written match).

### 4. Notification output (`formatNotification`)

- With written matches: `"dou 3 new, djinni 2 new · top 42"`
  (only sources with `written > 0` are listed; `top` is the written-match max).
- With no written matches: `"No new matches · scanned 29"`
  (`scanned` = sum of all sources' `found`).

### 5. `jobs.mjs` integration

1. Capture each source's result length before spreading into `jobs`, and call
   `recordFound(summary, "<source>", arr.length)`. (Today the results are
   spread inline via `jobs.push(...(await fetch...))`.)
2. After dedup: `recordMerged(summary, mergedCount)`.
3. In the scoring loop, replace each bare `continue` path so it also records the
   outcome: `seen` (already-seen early continue), `excluded` (title), `low`
   (below score / no role), `written` (package written). On a written match call
   `recordTop(summary, scored.score, \`${job.title} @ ${job.company}\`)`.
4. At the end: `log("\n" + formatTable(summary))`, then
   `notify(formatNotification(summary))` **unconditionally** (replacing the
   current `if (written > 0) notify(...)`).

The existing per-job `log("  · skip ...")` / `log("  ✓ MATCH ...")` lines stay —
the table is an addition, not a replacement.

## Tests — `test/run-summary.test.mjs`

Pure module, fully covered:

- `recordFound` / `recordOutcome` tally into the right source bucket and create
  buckets lazily.
- `recordTop` keeps the maximum across multiple calls and ignores lower scores.
- `formatTable` includes a row per source, the header, the `merged` line when
  `merged > 0` (and omits it when 0), and the `top score` line only when a top
  exists.
- `formatNotification` returns the per-source "N new" form when there are
  written matches, and the "No new matches · scanned N" form when there are
  none.

## Affected files

- `lib/run-summary.mjs` — new pure module (accumulator + formatters)
- `jobs.mjs` — record counts through the run; print table; always notify
- `test/run-summary.test.mjs` — unit tests for the pure module

## Out of scope (YAGNI)

- No run-to-run history or trend tracking; no new state files on disk.
- No dashboard banner / HTML changes.
- No "suspicious zero" alerting logic (a found=0 is visible in the table, but no
  separate threshold/notification is added here).
- No changes to scoring, dedup, or the per-job log lines.
