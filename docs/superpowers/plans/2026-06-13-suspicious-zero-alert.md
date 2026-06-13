# Suspicious-Zero Scraper Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a separate ⚠️ notification when a source that returned vacancies on the previous run returns `found = 0` this run, so a silently broken scraper is caught.

**Architecture:** A new pure module `lib/source-health.mjs` compares this run's per-source `found` counts (from the run summary) against the previous run's counts stored in a gitignored `source-health.json`. `jobs.mjs` loads the previous counts, detects regressions to zero, fires a separate alert banner, and persists the merged counts. One run of history; only sources that actually ran are updated.

**Tech Stack:** Node.js (ESM), `node:test`, no external dependencies.

---

## File Structure

- `lib/source-health.mjs` (create) — pure: `currentCounts`, `detectRegressions`, `mergeCounts`, `formatAlert`.
- `jobs.mjs` (modify) — load prev counts, detect regressions, alert, persist.
- `test/source-health.test.mjs` (create) — unit tests.
- `.gitignore` (modify) — add `source-health.json`.

`source-health.json` shape: `{ "dou": 25, "djinni": 15, "jooble": 0, "linkedin": 4 }`.

---

## Task 1: Pure source-health module

**Files:**
- Create: `lib/source-health.mjs`
- Test: `test/source-health.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/source-health.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentCounts, detectRegressions, mergeCounts, formatAlert,
} from "../lib/source-health.mjs";

// Build a minimal run-summary-shaped object for tests.
function summaryOf(counts) {
  const sources = {};
  for (const [s, found] of Object.entries(counts)) sources[s] = { found };
  return { sources };
}

test("currentCounts extracts found for every source that ran", () => {
  assert.deepEqual(currentCounts(summaryOf({ dou: 12, jooble: 0 })), { dou: 12, jooble: 0 });
});

test("detectRegressions flags a source that dropped from >0 to 0", () => {
  const prev = { dou: 25, djinni: 15 };
  assert.deepEqual(
    detectRegressions(prev, summaryOf({ dou: 0, djinni: 15 })),
    [{ source: "dou", was: 25 }],
  );
});

test("detectRegressions ignores a source that was already 0", () => {
  assert.deepEqual(detectRegressions({ jooble: 0 }, summaryOf({ jooble: 0 })), []);
});

test("detectRegressions ignores a source with no previous record", () => {
  assert.deepEqual(detectRegressions({}, summaryOf({ newsrc: 0 })), []);
});

test("detectRegressions does not flag a source that still has results", () => {
  assert.deepEqual(detectRegressions({ dou: 25 }, summaryOf({ dou: 10 })), []);
});

test("mergeCounts overwrites with current and retains sources absent this run", () => {
  const prev = { dou: 25, linkedin: 4 };
  const current = { dou: 0, djinni: 15 };
  assert.deepEqual(mergeCounts(prev, current), { dou: 0, linkedin: 4, djinni: 15 });
});

test("formatAlert renders one source", () => {
  assert.equal(formatAlert([{ source: "dou", was: 25 }]), "⚠️ dou returned 0 (was 25)");
});

test("formatAlert joins multiple sources with semicolons", () => {
  assert.equal(
    formatAlert([{ source: "dou", was: 25 }, { source: "jooble", was: 8 }]),
    "⚠️ dou returned 0 (was 25); jooble returned 0 (was 8)",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/source-health.test.mjs`
Expected: FAIL — `Cannot find module '../lib/source-health.mjs'`.

- [ ] **Step 3: Implement the module**

Create `lib/source-health.mjs`:

```js
// Pure scraper-health helpers for the suspicious-zero alert in jobs.mjs.
// Compare this run's per-source found counts (from the run summary) against the
// previous run's stored counts and flag any source that dropped to zero.
// No side effects — file load/save lives in jobs.mjs.

export function currentCounts(summary) {
  const out = {};
  for (const [source, b] of Object.entries(summary.sources)) {
    out[source] = b.found;
  }
  return out;
}

export function detectRegressions(prev, summary) {
  const regressions = [];
  for (const [source, b] of Object.entries(summary.sources)) {
    if (b.found === 0 && (prev[source] ?? 0) > 0) {
      regressions.push({ source, was: prev[source] });
    }
  }
  return regressions;
}

export function mergeCounts(prev, current) {
  return { ...prev, ...current };
}

export function formatAlert(regressions) {
  return "⚠️ " + regressions
    .map((r) => `${r.source} returned 0 (was ${r.was})`)
    .join("; ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/source-health.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add lib/source-health.mjs test/source-health.test.mjs
git commit -m "feat: add pure source-health helpers for suspicious-zero detection"
```

---

## Task 2: Wire the alert into jobs.mjs

**Files:**
- Modify: `jobs.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Import the module**

In `jobs.mjs`, after the line:

```js
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";
```

add:

```js
import { currentCounts, detectRegressions, mergeCounts, formatAlert } from "./lib/source-health.mjs";
```

- [ ] **Step 2: Add the state-file constant**

In `jobs.mjs`, after the line:

```js
const SEEN_FILE = join(__dir, "jobs-seen.json");
```

add:

```js
const HEALTH_FILE = join(__dir, "source-health.json");
```

- [ ] **Step 3: Load the previous run's counts**

In `jobs.mjs`, after the line:

```js
const seen = loadSeen();
```

add:

```js

// source-health.json records each source's `found` count from the last run so we
// can warn when a source that had results suddenly returns zero (a likely sign
// its scraper broke). Missing/unparseable file → no history (no alerts, just seed).
function loadHealth() {
  try { return JSON.parse(readFileSync(HEALTH_FILE, "utf8")); }
  catch { return {}; }
}
const prevHealth = loadHealth();
```

- [ ] **Step 4: Detect regressions, alert, and persist**

In `jobs.mjs`, find:

```js
// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));
```

and insert immediately after it:

```js

// Scraper-health: warn (separate banner) if a source that had results on the
// previous run returned 0 this run, then persist this run's counts for next time.
const regressions = detectRegressions(prevHealth, summary);
if (regressions.length) notify(formatAlert(regressions));
writeFileSync(HEALTH_FILE, JSON.stringify(mergeCounts(prevHealth, currentCounts(summary)), null, 0));
```

(The normal `notify(formatNotification(summary))` at the end of the file stays
unchanged, so the alert banner fires before the digest banner.)

- [ ] **Step 5: Gitignore the state file**

In `.gitignore`, after the line:

```
jobs-seen.json
```

add:

```
source-health.json
```

- [ ] **Step 6: Syntax-check**

Run: `node --check jobs.mjs`
Expected: no output (syntax OK).

- [ ] **Step 7: Confirm the state file is ignored**

Run: `git check-ignore source-health.json`
Expected: prints `source-health.json` (it is ignored).

- [ ] **Step 8: Run the full suite (no regressions)**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 9: Live alert smoke test (optional, network-dependent)**

Jooble returns 0 without `JOOBLE_API_KEY`, so seed a non-zero prior count for it
to force a regression, then run:

```bash
echo '{"jooble":8}' > source-health.json
DOU_ONLY=1 node jobs.mjs 2>&1 | tail -8
```

Expected: a ⚠️ banner `"⚠️ jooble returned 0 (was 8)"` appears, the digest banner
also appears, and `source-health.json` afterward holds the real counts
(`jooble: 0`, plus `dou`/`djinni` from this run). Then remove the test file if you
don't want it to seed the next run: `rm -f source-health.json` (it's gitignored
either way).

- [ ] **Step 10: Commit**

```bash
git add jobs.mjs .gitignore
git commit -m "feat: alert when a previously-working source returns zero"
```

---

## Self-Review Notes

- **Spec coverage:** pure module with the four functions (Task 1 Step 3); regression-to-zero trigger via `detectRegressions` (Task 1, Task 2 Step 4); gitignored `source-health.json` state (Task 2 Steps 2, 5); update only sources that ran + retain skipped via `mergeCounts` (Task 1 test + Task 2 Step 4); separate alert banner before the digest banner (Task 2 Step 4); first run seeds with no alert (`loadHealth` returns `{}` → `detectRegressions` finds nothing) (Task 2 Step 3). Out-of-scope items (percentage drop, deeper history, dashboard, auto-retry, per-source banners) are absent.
- **Type/name consistency:** `currentCounts(summary)`, `detectRegressions(prev, summary)`, `mergeCounts(prev, current)`, `formatAlert(regressions)` named identically in the module, the tests, and the `jobs.mjs` import. `HEALTH_FILE` / `loadHealth` / `prevHealth` used consistently. Regression objects use `{ source, was }` everywhere.
- **No placeholders:** every step has concrete code and an exact command with expected output.
