# Suspicious-Zero Scraper Alert — Design

**Date:** 2026-06-13
**Status:** Approved
**Scope:** When a source that returned vacancies on the previous run suddenly
returns `found = 0` (markup change, block, API outage), send a separate ⚠️
macOS notification so a silently broken scraper does not go unnoticed.

## Problem (evidence)

The run-summary digest now *shows* per-source `found` (including `0`), but it
does not *alert*. A source that quietly breaks — DOU returning 0 today after 25
yesterday because its RSS/markup changed — is only visible to someone reading the
log. The whole point of tracking per-source counts was to catch silent scraper
failure; surfacing it passively is half the job.

## Decision: regression-to-zero, separate alert, one-run memory

- **Trigger:** a source's `found === 0` this run **and** `> 0` on the previous
  run. A source that is always empty (e.g. Jooble without `JOOBLE_API_KEY`) never
  alerts, because its previous value was also 0.
- **Delivery:** a separate ⚠️ notification, in addition to the normal digest
  notification. Two banners appear only when there is a regression; the normal
  case stays one banner.
- **Memory:** one run of history, persisted to a small gitignored JSON file.

## State

New gitignored file `source-health.json`, alongside `jobs-seen.json` /
`notify-state.json`:

```json
{ "dou": 25, "djinni": 15, "jooble": 0, "linkedin": 4 }
```

It stores each source's `found` from the most recent run.

**Update rule:** only sources that actually ran this run (present in
`summary.sources`) are updated. A source skipped this run — LinkedIn under
`DOU_ONLY` or a logged-out session, which leaves it absent from the summary —
keeps its stored value untouched: no alert, no reset. First run (file missing or
unparseable) seeds the file and emits no alerts.

## Architecture

### `lib/source-health.mjs` (new — pure, no I/O)

```js
currentCounts(summary)            // → { source: found } for sources that ran this run
detectRegressions(prev, summary)  // → [{ source, was }] for sources found===0 now and prev>0
mergeCounts(prev, current)        // prev ⊕ current; current overwrites, keys absent from current are retained
formatAlert(regressions)          // → "⚠️ DOU returned 0 (was 25); Jooble returned 0 (was 8)"
```

- `currentCounts` reads `summary.sources[source].found` for every source key
  present in the summary.
- `detectRegressions` iterates the sources that ran this run; for each whose
  `found === 0`, it checks `prev[source] > 0` and, if so, emits
  `{ source, was: prev[source] }`. Sources missing from `prev` are not flagged.
- `mergeCounts(prev, current)` returns `{ ...prev, ...current }` — current
  overwrites, and any source in `prev` but not in `current` (didn't run) is
  preserved.
- `formatAlert` joins per-source `"<source> returned 0 (was <n>)"` with `"; "`
  and prefixes a single `⚠️ `.

File load/save lives in `jobs.mjs`, mirroring how `jobs-seen.json` is handled.

### `jobs.mjs` integration

1. Near the top, load `source-health.json` into `prevHealth` (empty object on
   missing/unparseable file), mirroring `loadSeen()`.
2. After all sources are gathered and deduped (all `recordFound` calls done):
   `const regressions = detectRegressions(prevHealth, summary)`.
3. After printing the digest table, **before** the normal digest notification:
   if `regressions.length > 0`, call `notify(formatAlert(regressions))` as a
   separate banner (reusing the existing `notify()`), then proceed to the normal
   `notify(formatNotification(summary))`.
4. Persist `mergeCounts(prevHealth, currentCounts(summary))` to
   `source-health.json`.

`notify()` already prefers `Notifier.app` and falls back to `osascript`; the
alert reuses it unchanged.

## Tests — `test/source-health.test.mjs`

Pure module, fully covered:

- `currentCounts` returns `found` only for sources present in the summary.
- `detectRegressions`:
  - `found===0` now and `prev>0` → one regression with the correct `was`;
  - `found===0` now and `prev===0` (or `prev` missing the source) → none;
  - `found>0` now → none.
- `mergeCounts`: current overwrites prev; a source in prev but absent from current
  (e.g. LinkedIn skipped) is retained, not reset.
- `formatAlert`: single-source string, and multi-source joined with `"; "`.

## Affected files

- `lib/source-health.mjs` — new pure module
- `jobs.mjs` — load prev health, detect regressions, alert, persist
- `test/source-health.test.mjs` — unit tests
- `.gitignore` — add `source-health.json`

## Out of scope (YAGNI)

- Percentage-drop detection (only regression to exactly 0).
- History deeper than one run; trend charts.
- A dashboard banner for scraper health.
- Auto-retry / auto-restart of a broken scraper.
- Per-source alert thresholds or one-banner-per-source delivery (a single
  combined banner is used).
