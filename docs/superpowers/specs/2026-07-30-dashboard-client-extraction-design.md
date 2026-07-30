# Dashboard client JS extraction — design

Date: 2026-07-30
Status: approved

## Goal

The dashboard's client-side JavaScript (~200 lines) lives inside a template
literal in `dashboard.mjs`. Consequences: it cannot use backticks or `${}`
(the generator would interpolate them), none of it is unit-testable, and it
hand-mirrors server logic (`mergeEntry`, `statusOf`, `isNew`) that can drift
silently — the `autoStatus` regression caught in review is exactly that class
of bug. Extract the client code into standalone files with a tested pure core.

Constraints: no new dependencies (`node:test` only), the served page stays a
single self-contained HTML document, and the documented `file://` offline
fallback keeps working. Behavior of the dashboard is unchanged.

## Approach

Two files, both inlined into the generated HTML at build time by
`dashboard.mjs` via `readFileSync`:

1. **`lib/dashboard-client-core.cjs`** — pure logic, zero DOM/`fetch`/
   `localStorage` references, safe to `require()` from tests. `.cjs` so Node
   loads it as CommonJS inside this ESM package; the browser never sees the
   extension — only the file's text, inlined into `<script>`.
   Ends with the CommonJS export list; in the browser `module` is undefined,
   so the tail is guarded: `if (typeof module !== "undefined") module.exports = {…}`.
2. **`lib/dashboard-client-dom.js`** — the thin DOM/network glue: render,
   click handlers, state-server fetch, localStorage fallback wiring. Calls
   core functions as plain script-scope globals. Not unit-tested (by design —
   the depth decision was "pure logic only, no new dependencies").

`dashboard.mjs` keeps: package parsing, sorting, card markup, CSS, and the
page template. The inline `<script>` becomes:

```js
const clientJs = [
  readFileSync(join(__dir, "lib", "dashboard-client-core.cjs"), "utf8"),
  readFileSync(join(__dir, "lib", "dashboard-client-dom.js"), "utf8"),
].join("\n");
if (clientJs.includes("</script>")) throw new Error("client JS must not contain </script>");
```

…interpolated once into the HTML template. A missing client file fails the
build loudly (`readFileSync` throws) — that is a build error, not a runtime
concern.

Side benefit: the client code leaves the template literal, so backticks and
template strings become legal in it again (the string-concatenation
workaround in `renderFunnel` can be simplified).

## Core contract

Functions take data, not DOM elements:

- `statusOf(entry)` → `"new" | stored status` (entry = state map value or undefined)
- `mergeEntryLocal(entry, patch)` → new entry or `null` when empty — the
  offline mirror of the server's `mergeEntry` semantics (status/appliedAt/note
  add-and-clear rules), minus `updatedAt` bookkeeping
- `cardMatches(card, filters)` — the applyFilter predicate;
  `card = { status, source, score, search, fresh, detailsOpen }`,
  `filters = { statusSel: string[], srcSel: string[], minScore, query }`
- `computeFunnel(cards)` — `cards = [{ status, source }]` →
  `{ applied, answered, interview, rejected, bySrc }` (answered = any
  post-applied movement; a rejection is a response)
- `formatFunnel(funnel)` → the header line string ("" when applied = 0)
- `daysAgo(iso, nowMs)` → `"today" | "<n>d ago" | ""`
- `isNew(generatedISO, lastVisitISO)` → boolean
- Shared constants: `STATUSES`, `POST_APPLIED`

The DOM layer owns everything else: `renderCard`, `applyFilter` (DOM walk +
counters, delegating the per-card decision to `cardMatches`), `renderFunnel`
(collect card data, delegate to `computeFunnel`/`formatFunnel`), state-server
client, filter persistence, init.

## Testing

New `test/dashboard-client-core.test.mjs`, loading the core via
`createRequire(import.meta.url)`:

- `computeFunnel`: empty board; full funnel with per-source breakdown;
  rejected counts as answered
- `formatFunnel`: empty → `""`; percentages and rejected tail
- `cardMatches`: status multi-select incl. `fresh` pseudo-filter and the
  details-open override; source filter; min-score; text query
- `daysAgo` (today/Nd/invalid) and `isNew` (no baseline, newer, older, junk)
- **Parity test:** for a table of patches (set status, jump straight to
  answered, clear note, back to new), `mergeEntryLocal` must produce the same
  `{status, appliedAt, note}` as the server's `mergeEntry` from
  `lib/job-state.mjs` — this pins the two implementations together so they
  cannot drift silently again

Existing `test/dashboard-client.test.mjs` (server round-trip) is untouched.

## Error handling

- Build: missing client file or embedded `</script>` → `dashboard.mjs` throws
  before writing anything.
- Runtime: unchanged — the extracted code is the same code.

## Verification

- Full suite green.
- One staged-dashboard visual pass (same staging technique as the screenshot
  refresh: synthetic packages + staged state on a scratch server) confirming
  render, filters, status clicks, funnel line, and offline fallback badge all
  behave as before. No screenshot commits — the UI is unchanged.

## Implementation order

1. `lib/dashboard-client-core.cjs` + tests (TDD; port logic verbatim from the
   inline script, then simplify `renderFunnel` string building with template
   literals in the DOM layer)
2. `lib/dashboard-client-dom.js` + `dashboard.mjs` injection; delete the
   inline script body
3. Staged visual verification

Each step leaves the suite green; steps 1–2 are separately committable.
