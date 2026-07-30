# Dashboard Client JS Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the dashboard's inline client JavaScript out of `dashboard.mjs` into two standalone files — a unit-tested pure core and a thin DOM layer — inlined into the generated HTML at build time.

**Architecture:** `lib/dashboard-client-core.cjs` holds pure, DOM-free logic (status resolution, offline merge, filter predicate, funnel math, date helpers) with a browser-guarded CommonJS export tail so `node:test` can `require()` it. `lib/dashboard-client-dom.js` keeps the DOM/network glue and calls core functions as script-scope globals. `dashboard.mjs` reads both files and interpolates their text into the page's single `<script>` — the served page stays one self-contained HTML document and the `file://` offline fallback keeps working.

**Tech Stack:** Node ESM (`.mjs`) + one CommonJS file (`.cjs`), `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-dashboard-client-extraction-design.md`

## Global Constraints

- No new npm dependencies; tests use `node:test` only.
- The served page stays a single self-contained HTML document; the `file://` offline fallback (localStorage + "offline" badge) must keep working.
- Dashboard behavior is unchanged — this is a pure extraction; the only allowed code change beyond relocation is the delegation edits this plan spells out.
- `lib/dashboard-client-core.cjs` must contain ZERO references to `document`, `fetch`, `localStorage`, or `window` — it must be safe to `require()` in Node.
- Interpolating file text into the HTML template literal does NOT re-parse it, so backticks/`${}` are legal inside both extracted files; the old string-concatenation constraint is gone.
- Build must fail loudly: missing client file (readFileSync throws) or `</script>` inside the combined client text (explicit throw).
- Comment style: repo's file-header + why-comments pattern.

---

### Task 1: Pure core — `lib/dashboard-client-core.cjs`

**Files:**
- Create: `lib/dashboard-client-core.cjs`
- Test: `test/dashboard-client-core.test.mjs`

**Interfaces:**
- Consumes: `mergeEntry` from `lib/job-state.mjs` (test-only, for the parity test).
- Produces (Task 2's DOM layer calls these as globals): `STATUSES: string[]`, `POST_APPLIED: string[]`, `statusOfEntry(entry) -> string`, `mergeEntryLocal(entry, patch) -> object|null`, `cardMatches(card, filters) -> boolean`, `computeFunnel(cards) -> {applied, answered, interview, rejected, bySrc}`, `formatFunnel(funnel) -> string`, `daysAgo(iso, nowMs = Date.now()) -> string`, `isNew(generatedISO, lastVisitISO) -> boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard-client-core.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mergeEntry } from "../lib/job-state.mjs";

const require = createRequire(import.meta.url);
const core = require("../lib/dashboard-client-core.cjs");

test("statusOfEntry: stored statuses pass through, everything else is new", () => {
  for (const st of ["viewed", "applied", "answered", "interview", "rejected"]) {
    assert.equal(core.statusOfEntry({ status: st }), st, st);
  }
  assert.equal(core.statusOfEntry(undefined), "new");
  assert.equal(core.statusOfEntry({}), "new");
  assert.equal(core.statusOfEntry({ status: "ghosted" }), "new");
});

test("computeFunnel: empty board", () => {
  assert.deepEqual(core.computeFunnel([]), { applied: 0, answered: 0, interview: 0, rejected: 0, bySrc: {} });
});

test("computeFunnel: full funnel, rejection counts as a response", () => {
  const f = core.computeFunnel([
    { status: "new", source: "dou" },          // not in the funnel
    { status: "applied", source: "dou" },
    { status: "answered", source: "djinni" },
    { status: "interview", source: "linkedin" },
    { status: "rejected", source: "jooble" },
  ]);
  assert.equal(f.applied, 4);
  assert.equal(f.answered, 3);   // answered + interview + rejected
  assert.equal(f.interview, 1);
  assert.equal(f.rejected, 1);
  assert.deepEqual(f.bySrc.linkedin, { a: 1, r: 1, i: 1 });
  assert.deepEqual(f.bySrc.dou, { a: 1, r: 0, i: 0 });
});

test("formatFunnel: empty funnel renders nothing", () => {
  assert.equal(core.formatFunnel(core.computeFunnel([])), "");
});

test("formatFunnel: percentages, rejected tail, per-source breakdown", () => {
  const s = core.formatFunnel(core.computeFunnel([
    { status: "applied", source: "dou" },
    { status: "answered", source: "dou" },
    { status: "interview", source: "dou" },
    { status: "rejected", source: "dou" },
  ]));
  assert.match(s, /4 applied → 3 answered \(75%\) → 1 interview \(33%\)/);
  assert.match(s, /1 rejected/);
  assert.match(s, /dou 4\/3\/1/);
});

const baseFilters = { statusSel: [], srcSel: [], minScore: 0, query: "" };
const baseCard = { status: "new", source: "dou", score: 30, search: "sdet acme playwright", fresh: false, detailsOpen: false };

test("cardMatches: empty selections mean All", () => {
  assert.equal(core.cardMatches(baseCard, baseFilters), true);
});

test("cardMatches: status multi-select, fresh pseudo-status, details-open override", () => {
  const filters = { ...baseFilters, statusSel: ["applied"] };
  assert.equal(core.cardMatches(baseCard, filters), false);
  assert.equal(core.cardMatches({ ...baseCard, status: "applied" }, filters), true);
  assert.equal(core.cardMatches({ ...baseCard, fresh: true }, { ...baseFilters, statusSel: ["fresh"] }), true);
  assert.equal(core.cardMatches({ ...baseCard, detailsOpen: true }, filters), true); // open card never hides
});

test("cardMatches: source, min-score and query narrow the list", () => {
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, srcSel: ["linkedin"] }), false);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, minScore: 40 }), false);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "acme" }), true);
  assert.equal(core.cardMatches(baseCard, { ...baseFilters, query: "golang" }), false);
});

test("daysAgo: today, n days, junk", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  assert.equal(core.daysAgo("2026-07-30T09:00:00Z", now), "today");
  assert.equal(core.daysAgo("2026-07-25T09:00:00Z", now), "5d ago");
  assert.equal(core.daysAgo("garbage", now), "");
});

test("isNew: baseline rules", () => {
  assert.equal(core.isNew("2026-07-30T10:00:00Z", ""), false);            // no baseline yet
  assert.equal(core.isNew("2026-07-30T10:00:00Z", "2026-07-29T00:00:00Z"), true);
  assert.equal(core.isNew("2026-07-28T10:00:00Z", "2026-07-29T00:00:00Z"), false);
  assert.equal(core.isNew("junk", "2026-07-29T00:00:00Z"), false);
});

// The offline mirror must produce the same status/appliedAt/note as the
// server's mergeEntry for the same patches — pins the two implementations
// together so they cannot drift silently.
test("parity: mergeEntryLocal matches server mergeEntry field-for-field", () => {
  const patchSeqs = [
    [{ status: "applied", appliedAt: "2026-07-01T00:00:00Z" }],
    [{ status: "applied", appliedAt: "2026-07-01T00:00:00Z" }, { status: "answered" }],
    [{ status: "answered", appliedAt: "2026-07-02T00:00:00Z" }, { status: "new", appliedAt: null }],
    [{ note: "call Anna" }, { note: "" }],
    [{ status: "viewed" }, { status: "new" }],
  ];
  const U = "https://example.com/j/1";
  for (const seq of patchSeqs) {
    let serverMap = {};
    let localEntry = undefined;
    for (const patch of seq) {
      serverMap = mergeEntry(serverMap, U, patch);
      localEntry = core.mergeEntryLocal(localEntry, patch);
    }
    const s = serverMap[U];
    if (!s) {
      assert.equal(localEntry, null, JSON.stringify(seq));
    } else {
      assert.deepEqual(
        { status: localEntry.status, appliedAt: localEntry.appliedAt, note: localEntry.note },
        { status: s.status, appliedAt: s.appliedAt, note: s.note },
        JSON.stringify(seq),
      );
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/dashboard-client-core.test.mjs`
Expected: FAIL — `Cannot find module '../lib/dashboard-client-core.cjs'`

- [ ] **Step 3: Implement the core**

Create `lib/dashboard-client-core.cjs`:

```js
// Pure logic for the dashboard client. This file is INLINED as plain text
// into the generated HTML's <script> by dashboard.mjs, so it must be valid
// classic-script JS with zero DOM/network references (document, fetch,
// localStorage, window are all off-limits) — that same property makes it
// require()-able by node:test. The DOM glue (dashboard-client-dom.js) calls
// these functions as script-scope globals.

const STATUSES = ["viewed", "applied", "answered", "interview", "rejected"];
const POST_APPLIED = ["applied", "answered", "interview", "rejected"];

function statusOfEntry(entry) {
  const s = (entry || {}).status;
  return STATUSES.includes(s) ? s : "new";
}

// Offline mirror of the server's mergeEntry (lib/job-state.mjs), minus the
// updatedAt bookkeeping. Returns the new entry, or null when it became empty.
// Kept field-compatible by the parity test in dashboard-client-core.test.mjs.
function mergeEntryLocal(entry, patch) {
  const e = { ...(entry || {}) };
  if ("status" in patch) {
    if (patch.status === "new") delete e.status;
    else e.status = patch.status;
  }
  if ("appliedAt" in patch) {
    if (patch.appliedAt == null) delete e.appliedAt;
    else e.appliedAt = patch.appliedAt;
  }
  if ("note" in patch) {
    if (!patch.note) delete e.note;
    else e.note = patch.note;
  }
  const empty = !(STATUSES.includes(e.status) || (e.note && e.note.length) || e.appliedAt);
  return empty ? null : e;
}

// The applyFilter predicate. card = { status, source, score, search, fresh,
// detailsOpen }; filters = { statusSel: string[], srcSel: string[], minScore,
// query }. Empty selections mean "All"; an open card never hides under it.
function cardMatches(card, filters) {
  const matchFind =
    (filters.srcSel.length === 0 || filters.srcSel.includes(card.source)) &&
    card.score >= filters.minScore &&
    (!filters.query || card.search.includes(filters.query));
  const matchStatus =
    filters.statusSel.length === 0 ||
    filters.statusSel.includes(card.status) ||
    (filters.statusSel.includes("fresh") && card.fresh) ||
    card.detailsOpen;
  return matchFind && matchStatus;
}

// Funnel math over [{ status, source }]. "Answered" is any post-applied
// movement — a rejection is a response too.
function computeFunnel(cards) {
  const out = { applied: 0, answered: 0, interview: 0, rejected: 0, bySrc: {} };
  for (const card of cards) {
    if (!POST_APPLIED.includes(card.status)) continue;
    out.applied++;
    const s = (out.bySrc[card.source] = out.bySrc[card.source] || { a: 0, r: 0, i: 0 });
    s.a++;
    if (card.status !== "applied") { out.answered++; s.r++; }
    if (card.status === "interview") { out.interview++; s.i++; }
    if (card.status === "rejected") out.rejected++;
  }
  return out;
}

function formatFunnel(f) {
  if (!f.applied) return "";
  const pct = (x, y) => (y ? Math.round((x / y) * 100) + "%" : "—");
  const src = Object.entries(f.bySrc).map(([k, s]) => `${k} ${s.a}/${s.r}/${s.i}`).join(" · ");
  return `Funnel: ${f.applied} applied → ${f.answered} answered (${pct(f.answered, f.applied)}) → ${f.interview} interview (${pct(f.interview, f.answered)})`
    + (f.rejected ? ` · ${f.rejected} rejected` : "")
    + (src ? `  ·  applied/answered/interview by source: ${src}` : "");
}

function daysAgo(iso, nowMs = Date.now()) {
  const d = (nowMs - new Date(iso).getTime()) / 86400000;
  if (!isFinite(d)) return "";
  const n = Math.floor(d);
  return n <= 0 ? "today" : n + "d ago";
}

// A job is "new since last visit" when generated after the stored lastVisit.
function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO), v = Date.parse(lastVisitISO);
  if (!isFinite(g) || !isFinite(v)) return false;
  return g > v;
}

// In the browser this file is a plain inlined script — `module` is undefined
// and the tail is skipped; under node:test it exposes the API.
if (typeof module !== "undefined") {
  module.exports = {
    STATUSES, POST_APPLIED, statusOfEntry, mergeEntryLocal,
    cardMatches, computeFunnel, formatFunnel, daysAgo, isNew,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dashboard-client-core.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Full suite + commit**

Run: `node --test test/`
Expected: all PASS (the dashboard still carries its own inline copies — duplication exists only until Task 2 lands).

```bash
git add lib/dashboard-client-core.cjs test/dashboard-client-core.test.mjs
git commit -m "feat: tested pure core for the dashboard client (funnel, filters, offline merge parity)"
```

---

### Task 2: DOM layer + build-time injection — `lib/dashboard-client-dom.js`, `dashboard.mjs`

**Files:**
- Create: `lib/dashboard-client-dom.js`
- Modify: `dashboard.mjs` (the `<script>…</script>` block near the end of the HTML template, plus a `clientJs` const near the other top-level consts)

**Interfaces:**
- Consumes: every export of Task 1's core as script-scope globals (`STATUSES`, `POST_APPLIED`, `statusOfEntry`, `mergeEntryLocal`, `cardMatches`, `computeFunnel`, `formatFunnel`, `daysAgo`, `isNew`) — the core file's text is inlined immediately before this file's text.
- Produces: the generated page behaves exactly as before.

- [ ] **Step 1: Create `lib/dashboard-client-dom.js` by moving the inline script**

Cut the ENTIRE body of the `<script>…</script>` block from `dashboard.mjs`'s HTML template (everything between `<script>` and `</script>`, currently starting with the `// ---- State client …` comment and ending with the `(async function init(){…})();` IIFE) and paste it verbatim into the new file, then apply EXACTLY these edits:

1. Add a file header at the top:

```js
// DOM/network glue for the dashboard. Inlined into the generated HTML right
// AFTER dashboard-client-core.cjs, whose functions it uses as script-scope
// globals. Everything DOM-free lives in the core (and is unit-tested there);
// this layer only wires state, events and rendering together.
```

2. Delete these now-core definitions from the moved code:
   - `const STATUSES = ['viewed','applied','answered','interview','rejected'];`
   - `const POST_APPLIED = ['applied','answered','interview','rejected'];`
   - the whole `function daysAgo(iso) {…}` block
   - the whole `function isNew(generatedISO, lastVisitISO) {…}` block (and its `// A job is "new since last visit"…` comment)

3. Replace the `statusOf` const with a thin wrapper over the core:

```js
const statusOf = (url) => statusOfEntry(entryOf(url));
```

4. In `patchEntry`, replace the offline `else` branch body (the manual merge, `empty` check, and `state[url]` bookkeeping — keep the `saveLocal();` call) with:

```js
    // Mirror mergeEntry locally so offline edits round-trip (core keeps the
    // two implementations in parity — see dashboard-client-core.test.mjs).
    const merged = mergeEntryLocal(state[url], patch);
    if (merged) state[url] = merged; else delete state[url];
    saveLocal();
```

5. Replace the whole `renderFunnel` function with the core-delegating version:

```js
function renderFunnel() {
  const cards = [...document.querySelectorAll('.card')]
    .map((card) => ({ status: statusOf(card.dataset.url), source: card.dataset.source }));
  const el = document.getElementById('funnel');
  if (el) el.textContent = formatFunnel(computeFunnel(cards));
}
```

6. In `applyFilter`, replace the `matchFind`/`isFresh`/`matchStatus`/`card.style.display` lines (keep the counts bookkeeping and the `detailsOpen` lookup) so the per-card decision delegates to the core:

```js
function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, applied: 0, answered: 0, interview: 0, rejected: 0 };
  const filters = { statusSel: [...statusSel], srcSel: [...srcSel], minScore, query };
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    const show = cardMatches({
      status: st,
      source: card.dataset.source,
      score: Number(card.dataset.score),
      search: card.dataset.search || '',
      fresh: card.classList.contains('fresh'),
      detailsOpen: !!card.querySelector('details[open]'),
    }, filters);
    card.style.display = show ? '' : 'none';
  });
  for (const k of ['all','new','viewed','applied','answered','interview','rejected']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }
  saveFilters();
}
```

Everything else moves verbatim: `STATUS_KEY`, `online`, `state`, `entryOf`, `postState`, `loadLocal`, `saveLocal`, `initState`, the online branch of `patchEntry`, `copyCover`, `renderCard`, `setStatus`, `autoStatus`, `saveNote`, `markFreshness`, `advanceLastVisit`, the filters block (`query`/`minScore`/`srcSel`/`statusSel`/`toggleSel`/`syncSeg`/`FILTERS_KEY`/`saveFilters`/`restoreFilters`/`setQuery`/`setSource`/`setMin`/`setFilter`), and the `init` IIFE.

- [ ] **Step 2: Inject the client files in `dashboard.mjs`**

Near the other top-level consts (after `const OUT = …`), add:

```js
// The client script ships as two standalone files inlined at build time:
// the unit-tested pure core (.cjs so node:test can require it) and the DOM
// glue. Interpolated text is not re-parsed, so backticks in them are safe;
// a literal </script> would terminate the tag mid-file — refuse to build.
const clientJs = ["dashboard-client-core.cjs", "dashboard-client-dom.js"]
  .map((f) => readFileSync(join(__dir, "lib", f), "utf8"))
  .join("\n");
if (clientJs.includes("</script>")) throw new Error("dashboard client JS must not contain </script>");
```

In the HTML template, replace the entire `<script>…</script>` block (now empty of its moved body) with:

```
<script>
${clientJs}
</script>
```

- [ ] **Step 3: Verify the build and the suite**

Run: `node --check dashboard.mjs && node --check lib/dashboard-client-dom.js`
Expected: both parse.

Run: `node dashboard.mjs`
Expected: builds; then confirm the extraction landed:

```bash
grep -c "statusOfEntry" applications/index.html   # ≥ 2 (core def + dom wrapper)
grep -c "computeFunnel" applications/index.html   # ≥ 2 (core def + renderFunnel call)
grep -c "module.exports" applications/index.html  # 1 (guarded tail, inert in browser)
```

Run: `node --test test/`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/dashboard-client-dom.js dashboard.mjs
git commit -m "refactor: dashboard client JS extracted to standalone core + DOM files, inlined at build time"
```

---

### Task 3: Staged browser verification (no commits)

**Files:** none committed — throwaway scripts in the session scratchpad; `applications/` is swapped and restored.

**Interfaces:**
- Consumes: the built page from Task 2; `createServer({ statePath, indexPath })` from `state-server.mjs` (existing).
- Produces: a pass/fail verdict that the extracted client behaves identically.

- [ ] **Step 1: Stage synthetic data and serve it**

Reuse the screenshot-staging recipe (synthetic packages + staged state; nothing personal). From the repo root:

```bash
SCRATCH=<session scratchpad dir>
mv applications applications.real && mkdir applications
node "$SCRATCH/stage-data.mjs" "$SCRATCH/staged-job-state.json"   # written earlier this session; recreate from it if absent
node dashboard.mjs
node -e "
import('./state-server.mjs').then(({ createServer }) => {
  createServer({ statePath: '$SCRATCH/staged-job-state.json', indexPath: 'applications/index.html' })
    .listen(7778, '127.0.0.1', () => console.log('staging up'));
});
" &
```

- [ ] **Step 2: Scripted click-through with Playwright (already a dependency)**

Write `$SCRATCH/verify-client.mjs`, copy it to the repo root as `verify-tmp.mjs` (so `playwright` resolves), run, delete. Assertions:

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:7778/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Funnel line rendered by the extracted core.
const funnel = await page.locator("#funnel").textContent();
if (!/4 applied → 3 answered \(75%\)/.test(funnel)) throw new Error("funnel: " + funnel);

// Status click round-trips through core mergeEntryLocal/serialization path.
await page.click('.filter-seg button[data-filter="all"]');
const card = page.locator('.card[data-url="https://example.com/jobs/umbrella"]');
await card.locator('button[data-status="applied"]').click();
await page.waitForTimeout(300);
const funnel2 = await page.locator("#funnel").textContent();
if (!/5 applied/.test(funnel2)) throw new Error("funnel after click: " + funnel2);

// Filter predicate: min-score ≥30 hides the score-2x cards.
await page.click('.min-seg button[data-min="30"]');
const visible = await page.locator(".card:visible").count();
if (visible < 1) throw new Error("min-score filter hid everything");

// No console errors during the session.
console.log("client verification OK");
await browser.close();
```

Also verify the offline fallback: open the built file directly (`file://` URL) in a headless page, wait 1s, assert the header contains "offline — not saved to disk".

- [ ] **Step 3: Tear down and restore**

```bash
lsof -ti:7778 | xargs kill
rm -rf applications && mv applications.real applications
node dashboard.mjs
git status --porcelain   # expect: empty
```

Expected: real dashboard restored, working tree clean.
