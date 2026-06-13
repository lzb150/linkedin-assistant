# Run Summary (Per-Source Digest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the end of a `jobs.mjs` run, print a per-source summary table to the console and always send a short macOS notification with the run outcome.

**Architecture:** A new pure module `lib/run-summary.mjs` accumulates per-source counts (`found`, `excluded`, `seen`, `low`, `written`), a global `merged` count, and the top written match. `jobs.mjs` records into it through the run and calls two formatters at the end — `formatTable` (console) and `formatNotification` (macOS banner). No history, no new state files.

**Tech Stack:** Node.js (ESM), `node:test`, no external dependencies.

---

## File Structure

- `lib/run-summary.mjs` (create) — pure accumulator + `formatTable` / `formatNotification`.
- `jobs.mjs` (modify) — record counts; print table; always notify.
- `test/run-summary.test.mjs` (create) — unit tests for the pure module.

Source `job.source` strings are lowercase: `dou`, `djinni`, `jooble`, `linkedin`.

---

## Task 1: Pure run-summary module

**Files:**
- Create: `lib/run-summary.mjs`
- Test: `test/run-summary.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/run-summary.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatNotification,
} from "../lib/run-summary.mjs";

test("recordFound tallies raw counts into a lazily-created source bucket", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "dou", 0);
  assert.equal(s.sources.dou.found, 12);
  assert.equal(s.sources.dou.excluded, 0);
});

test("recordOutcome increments only the four known outcome kinds", () => {
  const s = newSummary();
  recordOutcome(s, "djinni", "seen");
  recordOutcome(s, "djinni", "seen");
  recordOutcome(s, "djinni", "written");
  recordOutcome(s, "djinni", "bogus"); // ignored
  assert.equal(s.sources.djinni.seen, 2);
  assert.equal(s.sources.djinni.written, 1);
  assert.equal(s.sources.djinni.found, 0); // not touched by outcomes
});

test("recordTop keeps the maximum score and ignores lower ones", () => {
  const s = newSummary();
  recordTop(s, 30, "A");
  recordTop(s, 42, "B");
  recordTop(s, 27, "C");
  assert.equal(s.top.score, 42);
  assert.equal(s.top.label, "B");
});

test("formatTable shows a row per source and the header", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordOutcome(s, "dou", "written");
  recordFound(s, "jooble", 5);
  const out = formatTable(s);
  assert.match(out, /Run summary/);
  assert.match(out, /found.*excl.*seen.*low.*NEW/);
  assert.match(out, /dou/);
  assert.match(out, /jooble/);
});

test("formatTable shows the merged line only when merged > 0", () => {
  const s = newSummary();
  recordFound(s, "dou", 1);
  assert.doesNotMatch(formatTable(s), /merged/);
  recordMerged(s, 2);
  assert.match(formatTable(s), /merged 2 cross-source duplicate\(s\)/);
});

test("formatTable shows the top-score line only when a top exists", () => {
  const s = newSummary();
  recordFound(s, "dou", 1);
  assert.doesNotMatch(formatTable(s), /top score/);
  recordTop(s, 42, "Senior AQA @ Acme");
  assert.match(formatTable(s), /top score: 42 \(Senior AQA @ Acme\)/);
});

test("formatNotification lists only sources with written matches plus the top", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "jooble", 5);
  recordOutcome(s, "dou", "written");
  recordOutcome(s, "dou", "written");
  recordOutcome(s, "dou", "written");
  recordTop(s, 42, "Senior AQA @ Acme");
  const out = formatNotification(s);
  assert.match(out, /dou 3 new/);
  assert.doesNotMatch(out, /jooble/); // 0 written
  assert.match(out, /top 42/);
});

test("formatNotification reports scanned total when nothing was written", () => {
  const s = newSummary();
  recordFound(s, "dou", 12);
  recordFound(s, "jooble", 5);
  recordOutcome(s, "dou", "seen");
  assert.equal(formatNotification(s), "No new matches · scanned 17");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/run-summary.test.mjs`
Expected: FAIL — `Cannot find module '../lib/run-summary.mjs'`.

- [ ] **Step 3: Implement the module**

Create `lib/run-summary.mjs`:

```js
// Pure accumulator + formatters for the end-of-run digest in jobs.mjs.
// No side effects — fully unit testable without running scrapers.
//
//   newSummary()                    → { sources: {}, merged: 0, top: null }
//   recordFound(s, source, n)       raw count from a source fetch (pre-dedup)
//   recordOutcome(s, source, kind)  kind: excluded | seen | low | written (post-dedup)
//   recordMerged(s, n)              global cross-source duplicates collapsed
//   recordTop(s, score, label)      keep the max-scoring WRITTEN match
//   formatTable(s)                  multi-line string for the console
//   formatNotification(s)           short one-line string for notify()

const OUTCOMES = ["excluded", "seen", "low", "written"];

export function newSummary() {
  return { sources: {}, merged: 0, top: null };
}

function bucket(summary, source) {
  if (!summary.sources[source]) {
    summary.sources[source] = { found: 0, excluded: 0, seen: 0, low: 0, written: 0 };
  }
  return summary.sources[source];
}

export function recordFound(summary, source, n) {
  bucket(summary, source).found += n;
}

export function recordOutcome(summary, source, kind) {
  if (!OUTCOMES.includes(kind)) return;
  bucket(summary, source)[kind] += 1;
}

export function recordMerged(summary, n) {
  summary.merged += n;
}

export function recordTop(summary, score, label) {
  if (!summary.top || score > summary.top.score) {
    summary.top = { score, label };
  }
}

export function formatTable(summary) {
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    `Run summary ${ts}`,
    "            found  excl  seen  low  NEW",
  ];
  for (const [source, b] of Object.entries(summary.sources)) {
    lines.push(
      "  " + source.padEnd(10) +
      String(b.found).padStart(4) + "  " +
      String(b.excluded).padStart(4) + "  " +
      String(b.seen).padStart(4) + "  " +
      String(b.low).padStart(4) + "  " +
      String(b.written).padStart(4)
    );
  }
  if (summary.merged > 0) {
    lines.push(`  merged ${summary.merged} cross-source duplicate(s)`);
  }
  if (summary.top) {
    lines.push(`  top score: ${summary.top.score} (${summary.top.label})`);
  }
  return lines.join("\n");
}

export function formatNotification(summary) {
  const written = Object.entries(summary.sources)
    .filter(([, b]) => b.written > 0)
    .map(([source, b]) => `${source} ${b.written} new`);
  if (written.length === 0) {
    const scanned = Object.values(summary.sources).reduce((a, b) => a + b.found, 0);
    return `No new matches · scanned ${scanned}`;
  }
  let line = written.join(", ");
  if (summary.top) line += ` · top ${summary.top.score}`;
  return line;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/run-summary.test.mjs`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass (run-summary, dedup, prune, relevance, notify-state).

- [ ] **Step 6: Commit**

```bash
git add lib/run-summary.mjs test/run-summary.test.mjs
git commit -m "feat: add pure run-summary accumulator and formatters"
```

---

## Task 2: Wire the summary into jobs.mjs

**Files:**
- Modify: `jobs.mjs`

- [ ] **Step 1: Import the module**

In `jobs.mjs`, after the existing import of `./lib/dedup.mjs` (line ~16), add:

```js
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatNotification,
} from "./lib/run-summary.mjs";
```

- [ ] **Step 2: Create the summary before gathering**

In `jobs.mjs`, replace this line:

```js
let jobs = [];
```

with:

```js
let jobs = [];
const summary = newSummary();
```

- [ ] **Step 3: Record raw found counts per source**

Replace the DOU gather block:

```js
// 1) DOU via RSS (no browser needed)
log("Gathering DOU (RSS)...");
try { jobs.push(...(await fetchDou(config.dou, log))); } catch (e) { log("DOU error:", e.message); }
```

with:

```js
// 1) DOU via RSS (no browser needed)
log("Gathering DOU (RSS)...");
try {
  const douJobs = await fetchDou(config.dou, log);
  recordFound(summary, "dou", douJobs.length);
  jobs.push(...douJobs);
} catch (e) { log("DOU error:", e.message); }
```

Replace the Djinni gather block:

```js
if (config.djinni?.enabled) {
  log("Gathering Djinni (jobs board)...");
  try { jobs.push(...(await fetchDjinni(config.djinni, log))); } catch (e) { log("Djinni error:", e.message); }
}
```

with:

```js
if (config.djinni?.enabled) {
  log("Gathering Djinni (jobs board)...");
  try {
    const djinniJobs = await fetchDjinni(config.djinni, log);
    recordFound(summary, "djinni", djinniJobs.length);
    jobs.push(...djinniJobs);
  } catch (e) { log("Djinni error:", e.message); }
}
```

Replace the Jooble gather block:

```js
if (config.jooble?.enabled) {
  log("Gathering Jooble (API)...");
  try { jobs.push(...(await fetchJooble(config.jooble, log))); } catch (e) { log("Jooble error:", e.message); }
}
```

with:

```js
if (config.jooble?.enabled) {
  log("Gathering Jooble (API)...");
  try {
    const joobleJobs = await fetchJooble(config.jooble, log);
    recordFound(summary, "jooble", joobleJobs.length);
    jobs.push(...joobleJobs);
  } catch (e) { log("Jooble error:", e.message); }
}
```

In the LinkedIn block, replace this line:

```js
      log("Gathering LinkedIn jobs (scraping, modest)...");
      jobs.push(...(await fetchLinkedInJobs(page, config.linkedin, log)));
```

with:

```js
      log("Gathering LinkedIn jobs (scraping, modest)...");
      const liJobs = await fetchLinkedInJobs(page, config.linkedin, log);
      recordFound(summary, "linkedin", liJobs.length);
      jobs.push(...liJobs);
```

- [ ] **Step 4: Record the merged count after dedup**

Replace:

```js
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);
```

with:

```js
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
recordMerged(summary, mergedCount);
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);
```

- [ ] **Step 5: Record outcomes in the scoring loop**

Replace the whole scoring loop (the `for (const job of jobs) { ... }` block) with the version below — same logic, with `recordOutcome` / `recordTop` added:

```js
let written = 0, considered = 0;
for (const job of jobs) {
  const id = identityKey(job);
  if (seen.has(id)) { recordOutcome(summary, job.source, "seen"); continue; }
  considered++;
  const excluded = excludedByTitle(job.title);
  if (excluded) {
    log(`  · skip [excluded:${excluded}] ${job.source}: ${job.title}`);
    recordOutcome(summary, job.source, "excluded");
    seen.add(id);
    continue;
  }
  const scored = scoreMessage(job.text);
  // Cold applications: strict gate — high score AND an automation/SDET role match.
  // A source may set its own minScore (e.g. Jooble's API gives only short
  // snippets, which score lower than full descriptions) — it overrides the global.
  const minScore = config[job.source]?.minScore ?? config.minScore ?? 25;
  const needRole = config.requireRole ? Boolean(scored.matchedRole) : true;
  if (scored.score < minScore || !needRole) {
    log(`  · skip [${scored.score}${scored.matchedRole ? "" : " no-role"}] ${job.source}: ${job.title}`);
    recordOutcome(summary, job.source, "low");
    seen.add(id);
    continue;
  }
  const { filename, markdown } = buildApplication(job, scored);
  writeFileSync(join(APPS, filename), markdown);
  log(`  ✓ MATCH [${scored.score}] ${job.source}: ${job.title} @ ${job.company}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, `${job.title} @ ${job.company}`);
  seen.add(id);
  written++;
}
```

- [ ] **Step 6: Print the table and always notify**

Replace the end of the file — from the `writeFileSync(SEEN_FILE, ...)` line through `process.exit(0);`:

```js
writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 0));
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore" });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

if (written > 0) notify(`${written} matching job(s) ready — open applications/index.html`);
process.exit(0);
```

with:

```js
writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 0));
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore" });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

// Always notify with the run outcome (previously only fired when written > 0).
notify(formatNotification(summary));
process.exit(0);
```

- [ ] **Step 7: Syntax-check the modified script**

Run: `node --check jobs.mjs`
Expected: no output (syntax OK).

- [ ] **Step 8: Run the full suite (no regressions)**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 9: Live sanity check (optional, network-dependent)**

Run: `DOU_ONLY=1 node jobs.mjs`
Expected: the run ends with a `Run summary …` table listing `dou`/`djinni`/`jooble` rows, and a macOS notification appears even if nothing new was written.

- [ ] **Step 10: Commit**

```bash
git add jobs.mjs
git commit -m "feat: print per-source run summary and always notify the outcome"
```

---

## Self-Review Notes

- **Spec coverage:** pure module + accumulator (Task 1 Step 3); `found` raw pre-dedup (Task 2 Step 3); outcomes post-dedup attributed to `job.source` (Task 2 Step 5); `merged` from `mergedCount` (Task 2 Step 4); `top` among written only (Task 2 Step 5, `recordTop` on the written branch); console table before dashboard refresh + unconditional notification (Task 2 Step 6); notification two branches (Task 1 tests + `formatNotification`). No history, no dashboard banner, no zero-alert — matches Out of scope.
- **Type consistency:** function names (`newSummary`, `recordFound`, `recordOutcome`, `recordMerged`, `recordTop`, `formatTable`, `formatNotification`) identical across module, tests, and `jobs.mjs` import. Source strings lowercase everywhere.
- **No placeholders:** every step has concrete code and an exact command with expected output.
