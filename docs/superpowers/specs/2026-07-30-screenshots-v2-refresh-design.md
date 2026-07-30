# Screenshots v2 Refresh + README Sync — Design

Date: 2026-07-30
Status: approved

## Problem

`docs/dashboard.png` (June 8) predates Dashboard v2. The README shows none of
the v2 features (Applied status, notes, search, multi-select filters,
freshness ribbons, salary, alt-source links) and still describes v1 behavior
("New → Viewed", localStorage as the only store) as current.

## Scope

### 1. Screenshot gallery (docs/)

Four PNGs, captured with the repo's own Playwright against the live dashboard
served by `state-server.mjs` (so statuses and freshness render for real):

| File | Content |
|---|---|
| `docs/dashboard.png` | Hero: fresh dashboard, real jobs, NEW ribbons, salary, "also on:" row |
| `docs/filters.png` | Toolbar in action: multi-select status, source filter, search query |
| `docs/card.png` | Expanded card: cover letter, Copy button, private note, Applied + "applied Nd ago" |
| `docs/draft.png` | Inbox reply draft from `drafts/` — recruiter name and message text replaced |

Data policy: job data is public — shown as-is. The draft screenshot is
anonymized: recruiter name and their message replaced with realistic
placeholders before rendering.

Capture script is a one-off in the session scratchpad; NOT committed
(YAGNI — add a committed script only if refreshes become routine).

### 2. README updates

- Embed the gallery with captions: hero image up top (replaces the current
  one), the rest inside their feature sections.
- Fix stale text: "New → Viewed" → "New → Viewed → Applied" in "What it does".
- Rework the `## Dashboard` section so v1 localStorage behavior is no longer
  described as current; the v2 state-server model is the primary description,
  localStorage stays only as the documented offline fallback.

### 3. Micro-refactor (full honest audit yield — code is otherwise clean)

- `dashboard.mjs` `copyCover`: uses the deprecated implicit global `event`;
  pass the event explicitly.
- `dashboard.mjs` `setSource` / `setFilter`: unused `btn` parameter — drop it.

Out of scope: any larger refactor (recent refactors already removed
duplication; 100/100 tests pass), committed screenshot tooling, new features.

## Process

Branch `docs/screenshots-v2-refresh` → commits (spec, screenshots+README,
micro-refactor) → draft PR. Verify: `npm test` green; README images render on
the branch on GitHub.
