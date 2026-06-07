# Design: application-status tracking on the dashboard

**Date:** 2026-06-07
**Status:** approved for implementation
**Implementation file:** `dashboard.mjs` (the only file touched)

## Goal

Give visibility into which stage each vacancy is at on the HTML dashboard
(`applications/index.html`). Today there is only a binary local "seen" mark
(`localStorage` key `dashboardSeenJobs`). Replace it with a simple three-state
funnel plus filtering and a backup path.

## Decisions (locked during brainstorming)

- **Funnel:** `New → Viewed → Applied` (minimal — no interview/offer stages).
- **Storage:** `localStorage` plus JSON Export/Import buttons. No server, no
  disk writes from the browser — the dashboard stays a static `file://` page.
- **Per-card control:** a three-button segmented control.

## Data model

`localStorage` key **`jobStatus`** → an object of the form:

```json
{
  "https://jobs.dou.ua/companies/ciklum/vacancies/360334/": "viewed",
  "https://www.linkedin.com/jobs/view/4425183818/": "applied"
}
```

- The key is the vacancy URL (a stable identifier, already present as `data-url`
  on every card).
- Values: `"viewed"` | `"applied"`. **A missing entry means status "New".**
- Internal status codes: `new` (virtual, never stored), `viewed`, `applied`.

### Migration

On page load: if the old key `dashboardSeenJobs` (a Set of URLs) exists, each of
its entries is moved into `jobStatus` as `"viewed"` (without overwriting an
existing entry), then the old key is removed. One-time and idempotent.

## UI

### Card — segmented control

Below the "Open vacancy" link sits a group of three buttons:
New · Viewed · Applied. The active one is highlighted. A click immediately:
(1) writes the status to `localStorage`, (2) updates the card's visual state,
(3) recomputes the counters and re-applies the current filter.

On-screen button labels stay consistent with the existing dashboard's display
language; only this documentation is in English.

Card visual state by status:

| Status  | Card appearance                              |
|---------|----------------------------------------------|
| New     | normal                                        |
| Viewed  | dimmed (`opacity: .55`)                       |
| Applied | green left accent + check mark, not dimmed    |

### Header — filter and counters

The current "hide seen" checkbox is **replaced** by a segmented filter:
All · New (N) · Viewed (N) · Applied (N). "All" is active by default. Selecting
a filter shows/hides cards of the matching status. Counters recompute on every
status change.

### Export / Import

Two header buttons:

- **Export** — downloads `job-status.json` (a readable, formatted dump of the
  `jobStatus` map) via a `Blob` and a temporary `<a download>`.
- **Import** — a hidden `<input type="file">`; the chosen JSON is parsed and
  **merged** into `localStorage` (imported values override current ones), then
  the page re-renders. Invalid entries (values outside the allowed set) are
  silently ignored.

## Persistence across regeneration

The mechanism is unchanged: `jobs.mjs` → `dashboard.mjs` rewrite
`applications/index.html` on every run, but statuses live in `localStorage` and
are restored by `data-url` on load. Statuses survive any re-run of discovery.

## Changes in `dashboard.mjs`

1. In the card template, replace the `.seen-btn` block with a segmented status
   control (three `<button>`s carrying `data-status`).
2. In the header, replace the `<label class="filter">` checkbox with the
   segmented filter plus Export/Import buttons and a hidden file `<input>`.
3. CSS: remove `.seen-btn` / `.card.seen` / the filter checkbox styles; add
   styles for the segmented controls, card states (`.card.viewed`,
   `.card.applied`), and the header buttons.
4. JS `<script>`: replace the `dashboardSeenJobs` logic with:
   - load/save of the `jobStatus` map;
   - migration from `dashboardSeenJobs`;
   - `setStatus(url, status)` plus a card re-render;
   - `applyFilter()` with counters;
   - `exportStatus()` / `importStatus(file)`;
   - restoration of every card's state on load via `data-url`.

## Edge cases

- **Orphaned status:** if a vacancy's `.md` file is deleted, its `localStorage`
  entry remains and is still included in exports — harmless. No orphan pruning
  (YAGNI).
- **Garbage import:** values outside `{viewed, applied}` are dropped; a non-object
  input means the import is ignored without error.
- **Multiple browsers:** statuses are tied to a specific browser/profile;
  transfer is via Export/Import. This is the accepted trade-off of the chosen
  approach.

## Out of scope (YAGNI)

A local server, writing statuses to disk, "Interview/Offer/Rejected" statuses,
dates and notes, automatic sync, orphan pruning.
