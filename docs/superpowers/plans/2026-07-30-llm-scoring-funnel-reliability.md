# LLM Scoring, Funnel Stages & Source Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM re-scoring + tailored cover letters (via the local Claude CLI), source-degradation alerts, post-Applied funnel stages with a dashboard summary, and top-match notifications.

**Architecture:** Keyword scoring stays the sole gate; a new `lib/llm.mjs` helper calls `claude -p` once per gated match (score + why + red flags + cover letter in a single call) and every LLM failure degrades to today's behavior. Source health switches from "last count" to a 10-run history with a median-based degradation rule. Funnel stages extend the existing `job-state` status enum; the funnel summary renders client-side from live state.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Claude CLI (`claude -p`, already installed), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-llm-scoring-funnel-reliability-design.md`

## Global Constraints

- No new npm dependencies. Node stdlib + already-installed Playwright only.
- Nothing is ever sent automatically — scripts only write drafts/packages to disk.
- Every LLM failure path (CLI missing, timeout, bad JSON) returns `null` and the pipeline behaves exactly as before the change. `llmJSON` never throws.
- LLM never gates: which jobs get packages is decided by keyword score only (`minScore` + `requireRole` untouched).
- Tests: `node:test` files in `test/`, run with `node --test test/`.
- Notifications: macOS only, best-effort, never throw (existing `notify()` contracts).
- Comment style: follow the repo's existing file-header + why-comments pattern.
- One deviation from the spec, agreed at plan time: spec sections 2 and 3 are implemented as ONE LLM call per job (score + why + red_flags + cover in a single JSON response) instead of two — half the cost, same output. Since the LLM never gates and its result is only stored in the package, only gate-passing jobs are sent to the LLM (`minKeywordScore` is an extra floor on top of the gate, relevant for per-source gates like Jooble's 18).

---

### Task 1: LLM helper — `lib/llm.mjs`

**Files:**
- Create: `lib/llm.mjs`
- Test: `test/llm.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `extractJSON(text: string) -> object | null` — first `{…}` block parsed, else null.
  - `llmJSON(prompt: string, { model = "haiku", timeoutMs = 60_000, exec = execFile } = {}) -> Promise<object | null>` — `exec` is injectable for tests.
  - `buildJobPrompt(resume: string, job: {title, company, location, text}, lang: "en"|"uk"|"ru") -> string` — returns the combined score+cover prompt. The LLM's JSON answer has shape `{ score: number 0-100, why: string, red_flags: string[], cover: string }`.

- [ ] **Step 1: Write the failing tests**

Create `test/llm.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON, llmJSON, buildJobPrompt } from "../lib/llm.mjs";

test("extractJSON parses a clean JSON object", () => {
  assert.deepEqual(extractJSON('{"score":80}'), { score: 80 });
});

test("extractJSON pulls JSON out of surrounding prose", () => {
  assert.deepEqual(
    extractJSON('Sure! Here it is:\n{"score":55,"why":"ok"}\n'),
    { score: 55, why: "ok" },
  );
});

test("extractJSON returns null on missing or broken JSON", () => {
  assert.equal(extractJSON("no json here"), null);
  assert.equal(extractJSON('{"score": }'), null);
  assert.equal(extractJSON(""), null);
  assert.equal(extractJSON(null), null);
});

test("llmJSON resolves parsed JSON from stdout", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(null, '{"score":70,"why":"fit"}');
  assert.deepEqual(await llmJSON("p", { exec }), { score: 70, why: "fit" });
});

test("llmJSON passes model and prompt to the CLI", async () => {
  let seen;
  const exec = (cmd, args, _opts, cb) => { seen = { cmd, args }; cb(null, "{}"); };
  await llmJSON("my prompt", { model: "haiku", exec });
  assert.equal(seen.cmd, "claude");
  assert.deepEqual(seen.args, ["-p", "my prompt", "--model", "haiku"]);
});

test("llmJSON resolves null when the CLI errors (missing binary, timeout)", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(new Error("ENOENT"));
  assert.equal(await llmJSON("p", { exec }), null);
});

test("llmJSON resolves null when exec itself throws synchronously", async () => {
  const exec = () => { throw new Error("boom"); };
  assert.equal(await llmJSON("p", { exec }), null);
});

test("llmJSON resolves null on unparseable output", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(null, "I refuse to answer in JSON");
  assert.equal(await llmJSON("p", { exec }), null);
});

test("buildJobPrompt embeds resume, vacancy and language, truncates long text", () => {
  const job = { title: "SDET", company: "Acme", location: "Remote", text: "x".repeat(10_000) };
  const p = buildJobPrompt("MY RESUME BODY", job, "uk");
  assert.match(p, /MY RESUME BODY/);
  assert.match(p, /Title: SDET/);
  assert.match(p, /Company: Acme/);
  assert.match(p, /in Ukrainian/);
  assert.match(p, /JSON only/);
  assert.ok(p.length < 8_000); // 10k description was truncated to 6k
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/llm.test.mjs`
Expected: FAIL — `Cannot find module '../lib/llm.mjs'`

- [ ] **Step 3: Write the implementation**

Create `lib/llm.mjs`:

```js
// LLM helper over the local Claude CLI (`claude -p`). No API key — reuses the
// user's existing Claude Code install. Every failure (CLI missing, non-zero
// exit, timeout, unparseable output) resolves to null so callers degrade to
// the keyword-only pipeline. Never throws.
import { execFile } from "node:child_process";

// Pull the first {...} block out of possibly-noisy CLI output and parse it.
export function extractJSON(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// `exec` is injectable for tests.
export function llmJSON(prompt, { model = "haiku", timeoutMs = 60_000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      exec(
        "claude",
        ["-p", prompt, "--model", model],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : extractJSON(String(stdout))),
      );
    } catch { resolve(null); }
  });
}

// One prompt per matched job: fit score + one-line why + red flags + tailored
// cover letter, all in a single CLI call (half the cost of two calls).
const LANG_NAME = { en: "English", uk: "Ukrainian", ru: "Russian" };
export function buildJobPrompt(resume, job, lang) {
  return `You are screening job vacancies for one specific candidate.

CANDIDATE RESUME:
${resume}

VACANCY:
Title: ${job.title}
Company: ${job.company || "unknown"}
Location: ${job.location || "unknown"}
Description:
${(job.text || "").slice(0, 6000)}

Tasks:
1. Rate the candidate's fit for this vacancy from 0 (no fit) to 100 (perfect fit).
2. Explain the rating in ONE short sentence.
3. List concrete red flags for this candidate, if any (empty array if none).
4. Write a short cover letter (under 150 words, first person, no filler,
   grounded ONLY in facts present in the resume) in ${LANG_NAME[lang] || "English"}.

Respond with JSON only, no markdown fences:
{"score": <0-100>, "why": "<one sentence>", "red_flags": ["<flag>"], "cover": "<letter>"}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/llm.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `node --test test/`
Expected: all existing tests still PASS.

```bash
git add lib/llm.mjs test/llm.test.mjs
git commit -m "feat: LLM helper over the local Claude CLI (llmJSON, buildJobPrompt)"
```

---

### Task 2: LLM fields in application packages — `lib/application.mjs`

**Files:**
- Modify: `lib/application.mjs` (function `buildApplication`, currently `buildApplication(job, scored)`)
- Test: `test/application.test.mjs` (new file)

**Interfaces:**
- Consumes: nothing from Task 1 (the `llm` object is passed in by the caller; this module stays LLM-agnostic).
- Produces: `buildApplication(job, scored, llm = null) -> { filename, markdown }` where `llm` is `null` or `{ score: number, why: string, red_flags: string[], cover: string }`. When `llm` is present the frontmatter gains single-line `llm_score:` and `llm_why:` keys, and a non-empty `llm.cover` replaces the template cover note. When `llm` is `null` output is byte-identical to today.

- [ ] **Step 1: Write the failing tests**

Create `test/application.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApplication } from "../lib/application.mjs";

const job = {
  source: "dou",
  title: "Senior AQA",
  company: "Acme",
  location: "Remote",
  url: "https://example.com/j/1",
  text: "We need Playwright and TypeScript experience.",
};
const scored = { score: 32, matchedSkills: ["playwright", "typescript"], matchedRole: "aqa", penalties: [] };

test("without llm the package has no llm_ keys and uses the template cover", () => {
  const { markdown } = buildApplication(job, scored);
  assert.ok(!markdown.includes("llm_score:"));
  assert.ok(!markdown.includes("llm_why:"));
  assert.match(markdown, /I came across your "Senior AQA"/);
});

test("with llm the frontmatter carries llm_score and a single-line llm_why", () => {
  const llm = { score: 85, why: "Strong Playwright\nfit", red_flags: ["on-site only"], cover: "Dear team, custom letter." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /^llm_score: 85$/m);
  // newlines collapsed, red flags folded in — frontmatter values must stay one line
  assert.match(markdown, /^llm_why: Strong Playwright fit ⚠ on-site only$/m);
});

test("with llm the cover note is the LLM letter, not the template", () => {
  const llm = { score: 85, why: "fit", red_flags: [], cover: "Dear team, custom letter." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /Dear team, custom letter\./);
  assert.ok(!markdown.includes("I came across your"));
});

test("an empty llm cover falls back to the template", () => {
  const llm = { score: 85, why: "fit", red_flags: [], cover: "   " };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /I came across your "Senior AQA"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/application.test.mjs`
Expected: FAIL — the three `with llm` tests fail (no `llm_score:` in output, template cover used).

- [ ] **Step 3: Implement**

In `lib/application.mjs`, change the signature and add the llm handling:

```js
export function buildApplication(job, scored, llm = null) {
```

Replace the `const cover = ...` line with:

```js
  const llmCover = (llm?.cover || "").trim();
  const cover = llmCover || (COVER[lang] || COVER.en)(job.title, job.company, skills);
```

Add the frontmatter lines (right before the `resume:` interpolation). Build them next to `altFront`:

```js
  // LLM verdict, when available. Frontmatter is line-based, so why + red flags
  // are folded into one whitespace-collapsed line.
  const llmWhy = llm
    ? [String(llm.why || "").trim(), (llm.red_flags || []).length ? "⚠ " + llm.red_flags.join("; ") : ""]
        .filter(Boolean).join(" ").replace(/\s+/g, " ")
    : "";
  const llmFront = llm ? `\nllm_score: ${Math.round(Number(llm.score))}\nllm_why: ${llmWhy}` : "";
```

And in the template, extend the frontmatter (the line currently reading `penalties: ...`):

```js
penalties: ${scored.penalties.join(", ") || "—"}${llmFront}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/application.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Full suite + commit**

Run: `node --test test/`
Expected: all PASS.

```bash
git add lib/application.mjs test/application.test.mjs
git commit -m "feat: application packages carry llm_score/llm_why and an LLM cover letter"
```

---

### Task 3: Wire the LLM into job discovery — `jobs.mjs` + config

**Files:**
- Modify: `jobs.mjs` (section "5) Score + write application packages", lines ~148–180)
- Modify: `jobs.config.json` (add the `llm` block)

**Interfaces:**
- Consumes: `llmJSON`, `buildJobPrompt` from `lib/llm.mjs` (Task 1); `buildApplication(job, scored, llm)` (Task 2); `detectLang(text)` from `lib/lang.mjs` (existing).
- Produces: `jobs.config.json` gains `llm: { enabled, model, minKeywordScore, maxPerRun }`. The match loop becomes two phases; Task 7 consumes the `writtenList` array of `{ score: number, llmScore: number|null, label: string }` built in phase B — create it here.

`jobs.mjs` is a top-level script with no test harness (matching every other root script in this repo); verification is `node --check` + a live run with the LLM disabled.

- [ ] **Step 1: Add the config block**

In `jobs.config.json`, after the `"excludeTitle"` line, add:

```json
  "_llmComment": "LLM re-scoring + tailored cover letters via the local Claude CLI (claude -p). The LLM NEVER gates: keyword minScore/requireRole decide what gets a package; the LLM only ranks, explains, and writes the letter. Any CLI failure silently falls back to keyword-only packages. minKeywordScore is an extra floor (relevant where a per-source minScore is lower), maxPerRun caps CLI calls per run.",
  "llm": {
    "enabled": true,
    "model": "haiku",
    "minKeywordScore": 15,
    "maxPerRun": 15
  },
```

- [ ] **Step 2: Add imports and resume loading to `jobs.mjs`**

Next to the existing imports:

```js
import { llmJSON, buildJobPrompt } from "./lib/llm.mjs";
import { detectLang } from "./lib/lang.mjs";
```

Near the other file constants (after `const config = ...`):

```js
// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
function loadResume() {
  try { return readFileSync(join(__dir, "resume.txt"), "utf8"); } catch { return ""; }
}
const RESUME_TXT = loadResume();
const LLM = config.llm || {};
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;
```

- [ ] **Step 3: Restructure the match loop into two phases**

Replace the whole section `// 5) Score + write application packages...` (from `let written = 0, considered = 0;` through the end of the `for (const job of jobs)` loop) with:

```js
// 5a) Score all unseen jobs locally (cheap) and collect the gate-passers.
// Gate unchanged: per-source/global minScore + requireRole. LLM never gates.
let written = 0, considered = 0;
const matches = [];
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
  const minScore = config[job.source]?.minScore ?? config.minScore ?? 25;
  const needRole = config.requireRole ? Boolean(scored.matchedRole) : true;
  if (scored.score < minScore || !needRole) {
    log(`  · skip [${scored.score}${scored.matchedRole ? "" : " no-role"}] ${job.source}: ${job.title}`);
    recordOutcome(summary, job.source, "low");
    seen.add(id);
    continue;
  }
  matches.push({ id, job, scored });
}

// 5b) Strongest keyword matches first: LLM re-score + tailored letter (capped
// per run), then write the package. LLM failure → keyword-only package.
matches.sort((a, b) => b.scored.score - a.scored.score);
const writtenList = [];
let llmCalls = 0;
for (const { id, job, scored } of matches) {
  let llm = null;
  if (llmOn && scored.score >= (LLM.minKeywordScore ?? 15) && llmCalls < (LLM.maxPerRun ?? 15)) {
    llmCalls++;
    const res = await llmJSON(buildJobPrompt(RESUME_TXT, job, detectLang(job.text)), { model: LLM.model || "haiku" });
    if (res && Number.isFinite(Number(res.score))) llm = res;
    else log(`  · llm failed for: ${job.title} — keyword-only package`);
  }
  const { filename, markdown } = buildApplication(job, scored, llm);
  writeFileSync(join(APPS, filename), markdown);
  log(`  ✓ MATCH [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${job.title} @ ${job.company}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, `${job.title} @ ${job.company}`);
  writtenList.push({ score: scored.score, llmScore: llm ? Number(llm.score) : null, label: `${job.title} @ ${job.company}` });
  seen.add(id);
  written++;
}
```

- [ ] **Step 4: Verify**

Run: `node --check jobs.mjs`
Expected: no output (parses).

Run: `node --test test/`
Expected: all PASS.

Live smoke run without LLM cost: temporarily set `"enabled": false` in the config's `llm` block, run `DOU_ONLY=1 node jobs.mjs`, then restore `"enabled": true`.
Expected: run completes, packages written/skipped exactly as before, log shows no `llm` lines.

Then one live LLM run: `DOU_ONLY=1 node jobs.mjs` with `enabled: true`.
Expected: new packages (if any matches) contain `llm_score:` / `llm_why:` frontmatter and a tailored cover note. If no new matches appear (all seen), verify by deleting one recent identity from `jobs-seen.json` and re-running.

- [ ] **Step 5: Commit**

```bash
git add jobs.mjs jobs.config.json
git commit -m "feat: LLM re-scoring + tailored cover letters in job discovery (claude -p, never gates)"
```

---

### Task 4: Dashboard — LLM badge and sort

**Files:**
- Modify: `dashboard.mjs` (parse block ~line 29, sort ~line 45, card template ~line 76–105, CSS)

**Interfaces:**
- Consumes: `llm_score` / `llm_why` frontmatter keys (Task 2).
- Produces: cards sorted LLM-scored-first; `data-score` stays the KEYWORD score (the ≥30/≥40 min-score filter presets are keyword-scaled and unchanged).

`dashboard.mjs` render is untested today (script); keep it that way — the logic added is presentation-only.

- [ ] **Step 1: Parse the llm fields**

In the `.map((x) => ({ ...x, score: ... }))` chain, add `llm`:

```js
  .map((x) => ({
    ...x,
    score: parseInt(x.fm.score || "0", 10),
    llm: /^\d+$/.test(x.fm.llm_score || "") ? parseInt(x.fm.llm_score, 10) : null,
    generated: x.fm.generated || "",
  }));
```

- [ ] **Step 2: Sort LLM-scored cards first**

Replace the sort line:

```js
const items = [...byIdentity.values()].sort(
  (a, b) => (b.llm ?? -1) - (a.llm ?? -1) || b.score - a.score,
);
```

- [ ] **Step 3: Render the badge and the why-line**

In the card template, right after the `<div class="sub">…</div>` line, add:

```js
      ${it.llm != null ? `<div class="llm-row"><span class="llm">🤖 ${it.llm}</span> <span class="llm-why">${esc(f.llm_why || "")}</span></div>` : ""}
```

Add CSS (next to the `.sub` rules):

```css
  .llm-row { margin-top: 4px; font-size: 12px; }
  .llm { background: #8250df; color: #fff; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
  .llm-why { color: #57606a; font-style: italic; }
```

- [ ] **Step 4: Verify**

Run: `node dashboard.mjs --open`
Expected: builds without error; packages that have `llm_score` (from Task 3's live run) show the purple 🤖 badge + why-line and sort above unscored ones; cards without LLM data render exactly as before.

- [ ] **Step 5: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: dashboard shows LLM score badge + verdict and sorts LLM-scored jobs first"
```

---

### Task 5: Source degradation alerts — `lib/source-health.mjs`

**Files:**
- Modify: `lib/source-health.mjs` (full rewrite of the alert logic; `currentCounts` survives)
- Modify: `jobs.mjs` (health wiring, lines ~77–84 and ~188–192)
- Test: `test/source-health.test.mjs` (rewrite: drop `detectRegressions`/`mergeCounts` tests, keep `currentCounts`, add history/median/degradation tests)

**Interfaces:**
- Consumes: run summary shape `{ sources: { [name]: { found } } }` (existing `lib/run-summary.mjs`).
- Produces:
  - `currentCounts(summary) -> { [source]: number }` (unchanged)
  - `normalizeHistory(raw) -> { [source]: number[] }` — migrates the legacy flat `{source: number}` file to one-element histories; garbage → `{}`.
  - `median(nums: number[]) -> number` (0 for empty)
  - `detectDegradations(history, summary) -> Array<{ source, found, median }>` — flags `found < 0.3 * median(history[source])` when that median ≥ 5.
  - `appendHistory(history, counts) -> history` — appends this run's counts, trims each source to the last 10 (`HISTORY_LEN`).
  - `formatAlert(degradations) -> string`
  - Removed: `detectRegressions`, `mergeCounts` (drop-to-zero is subsumed: 0 < 0.3 × median whenever median ≥ 5).

- [ ] **Step 1: Rewrite the tests**

Replace the body of `test/source-health.test.mjs` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentCounts, normalizeHistory, median, detectDegradations, appendHistory, formatAlert, HISTORY_LEN,
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

test("normalizeHistory migrates the legacy flat format to one-element histories", () => {
  assert.deepEqual(normalizeHistory({ dou: 50, djinni: 55 }), { dou: [50], djinni: [55] });
});

test("normalizeHistory passes arrays through and drops garbage", () => {
  assert.deepEqual(normalizeHistory({ dou: [1, 2], bad: "x", worse: null }), { dou: [1, 2] });
  assert.deepEqual(normalizeHistory(null), {});
  assert.deepEqual(normalizeHistory("junk"), {});
});

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), 0);
});

test("detectDegradations flags a source well below its recent norm", () => {
  const history = { linkedin: [50, 48, 52, 55, 49] };
  assert.deepEqual(
    detectDegradations(history, summaryOf({ linkedin: 6 })),
    [{ source: "linkedin", found: 6, median: 50 }],
  );
});

test("detectDegradations subsumes the old drop-to-zero alert", () => {
  assert.deepEqual(
    detectDegradations({ dou: [25] }, summaryOf({ dou: 0 })),
    [{ source: "dou", found: 0, median: 25 }],
  );
});

test("detectDegradations ignores healthy sources and mild dips", () => {
  assert.deepEqual(detectDegradations({ dou: [50] }, summaryOf({ dou: 20 })), []); // 20 >= 15
});

test("detectDegradations ignores sources with a tiny norm (median < 5)", () => {
  assert.deepEqual(detectDegradations({ niche: [3, 4, 3] }, summaryOf({ niche: 0 })), []);
});

test("detectDegradations ignores sources with no history", () => {
  assert.deepEqual(detectDegradations({}, summaryOf({ newsrc: 0 })), []);
});

test("appendHistory appends and trims to HISTORY_LEN, keeps absent sources", () => {
  const history = { dou: Array.from({ length: HISTORY_LEN }, (_, i) => i), linkedin: [4] };
  const out = appendHistory(history, { dou: 99 });
  assert.equal(out.dou.length, HISTORY_LEN);
  assert.equal(out.dou.at(-1), 99);
  assert.equal(out.dou[0], 1);            // oldest entry dropped
  assert.deepEqual(out.linkedin, [4]);    // untouched when the source didn't run
});

test("formatAlert renders degradations", () => {
  assert.equal(
    formatAlert([{ source: "linkedin", found: 6, median: 50 }, { source: "dou", found: 0, median: 25 }]),
    "⚠️ linkedin: 6 found (recent median 50); dou: 0 found (recent median 25)",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/source-health.test.mjs`
Expected: FAIL — `normalizeHistory` etc. not exported.

- [ ] **Step 3: Rewrite `lib/source-health.mjs`**

```js
// Scraper-health helpers: keep a short history of per-source found counts and
// flag any source that degraded well below its recent norm — not just to zero
// (a slow selector decay looks like 50 → 20 → 6, never a clean 0).
// No side effects — file load/save lives in jobs.mjs.

export const HISTORY_LEN = 10;
const DEGRADE_RATIO = 0.3; // alert when found < 30% of the recent median
const MIN_MEDIAN = 5;      // ignore sources whose norm is tiny (noise)

export function currentCounts(summary) {
  const out = {};
  for (const [source, b] of Object.entries(summary.sources)) {
    out[source] = b.found;
  }
  return out;
}

// The legacy file format was { source: <last run's count> } — migrate each
// number to a one-element history. Garbage in → empty history out.
export function normalizeHistory(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [src, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[src] = v.filter((n) => Number.isFinite(n));
    else if (Number.isFinite(v)) out[src] = [v];
  }
  return out;
}

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectDegradations(history, summary) {
  const out = [];
  for (const [source, b] of Object.entries(summary.sources)) {
    const med = median(history[source] || []);
    if (med >= MIN_MEDIAN && b.found < med * DEGRADE_RATIO) {
      out.push({ source, found: b.found, median: med });
    }
  }
  return out;
}

export function appendHistory(history, counts) {
  const out = { ...history };
  for (const [src, n] of Object.entries(counts)) {
    out[src] = [...(out[src] || []), n].slice(-HISTORY_LEN);
  }
  return out;
}

export function formatAlert(degradations) {
  return "⚠️ " + degradations
    .map((d) => `${d.source}: ${d.found} found (recent median ${d.median})`)
    .join("; ");
}
```

- [ ] **Step 4: Rewire `jobs.mjs`**

Update the import:

```js
import { currentCounts, normalizeHistory, detectDegradations, appendHistory, formatAlert } from "./lib/source-health.mjs";
```

Update the `loadHealth` comment + call site (lines ~77–84):

```js
// source-health.json keeps the last 10 runs' `found` counts per source so we
// can warn when a source degrades well below its recent norm (a likely sign
// its scraper broke). Missing/unparseable/legacy file → normalized quietly.
function loadHealth() {
  try { return JSON.parse(readFileSync(HEALTH_FILE, "utf8")); }
  catch { return {}; }
}
const health = normalizeHistory(loadHealth());
```

(Remove the old `const prevHealth = loadHealth();` line.)

Update the alert block at the bottom (~lines 188–192):

```js
// Scraper-health: warn (separate banner) if a source came in far below its
// recent norm, then append this run's counts to the history.
const degraded = detectDegradations(health, summary);
if (degraded.length) notify(formatAlert(degraded));
writeFileSync(HEALTH_FILE, JSON.stringify(appendHistory(health, currentCounts(summary)), null, 0));
```

- [ ] **Step 5: Verify + commit**

Run: `node --test test/` — all PASS.
Run: `node --check jobs.mjs` — parses.

```bash
git add lib/source-health.mjs test/source-health.test.mjs jobs.mjs
git commit -m "feat: median-based source degradation alerts (10-run history, subsumes drop-to-zero)"
```

---

### Task 6: Funnel stages + dashboard funnel summary

**Files:**
- Modify: `lib/job-state.mjs` (`STATUSES` set line 6, `validatePatch` status list ~line 51)
- Modify: `dashboard.mjs` (client JS: `statusOf`, `patchEntry` offline branch, `setStatus`, `renderCard`; card status buttons; header filter buttons + counts; funnel block; CSS)
- Test: `test/job-state.test.mjs` (extend), `test/followup.test.mjs` (extend), `test/dashboard-client.test.mjs` (extend)

**Interfaces:**
- Consumes: existing `normalize` / `mergeEntry` / `validatePatch` / `statusOf` from `lib/job-state.mjs`; state server passes patches through `validatePatch` (no server change needed).
- Produces: valid stored statuses become `viewed | applied | answered | interview | rejected` ("new" stays virtual). Client-side constant `POST_APPLIED = ['applied','answered','interview','rejected']`: `appliedAt` is kept while a card stays anywhere post-applied and cleared only on a move back to new/viewed. `followup.mjs` keeps reminding ONLY `status === "applied"` (already true — no change).

- [ ] **Step 1: Write the failing tests**

Append to `test/job-state.test.mjs`:

```js
test("normalize keeps the new post-applied statuses", () => {
  for (const st of ["answered", "interview", "rejected"]) {
    const out = normalize({ [U]: { status: st } });
    assert.equal(out[U].status, st, st);
    assert.equal(statusOf(out, U), st);
  }
});

test("validatePatch accepts the new statuses and still rejects junk", () => {
  for (const st of ["answered", "interview", "rejected"]) {
    assert.equal(validatePatch({ status: st }), true, st);
  }
  assert.equal(validatePatch({ status: "ghosted" }), false);
});

test("mergeEntry keeps appliedAt when moving applied → answered", () => {
  let map = mergeEntry({}, U, { status: "applied", appliedAt: "2026-07-01T00:00:00Z" });
  map = mergeEntry(map, U, { status: "answered" });
  assert.equal(map[U].status, "answered");
  assert.equal(map[U].appliedAt, "2026-07-01T00:00:00Z");
});
```

Append to `test/followup.test.mjs` (uses the existing `dueReminders` import):

```js
test("post-applied stages are never reminded (answered/interview/rejected)", () => {
  const old = "2026-06-01T00:00:00Z";
  const stateMap = {
    "https://a/": { status: "answered", appliedAt: old },
    "https://b/": { status: "interview", appliedAt: old },
    "https://c/": { status: "rejected", appliedAt: old },
    "https://d/": { status: "applied", appliedAt: old },
  };
  const due = dueReminders({ stateMap, now: "2026-07-30T00:00:00Z", thresholdDays: 7 });
  assert.deepEqual(due.map((d) => d.url), ["https://d/"]);
});
```

Append to `test/dashboard-client.test.mjs` (inside a new test, reusing the file's `listen` helper and imports):

```js
test("the state server round-trips the new funnel statuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const U = "https://example.com/jobs/9/";
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  const port = await listen(srv);
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "interview" } }) });
  const state = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(state[U].status, "interview");
  await new Promise((r) => srv.close(r));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/job-state.test.mjs test/followup.test.mjs test/dashboard-client.test.mjs`
Expected: the job-state and dashboard-client additions FAIL (statuses rejected/stripped). The followup addition PASSES already (`dueReminders` filters `status === "applied"`) — it's a regression guard, keep it.

- [ ] **Step 3: Extend `lib/job-state.mjs`**

Line 6:

```js
const STATUSES = new Set(["viewed", "applied", "answered", "interview", "rejected"]); // "new" is virtual, never stored
```

In `validatePatch`:

```js
  if ("status" in patch && !["new", "viewed", "applied", "answered", "interview", "rejected"].includes(patch.status)) return false;
```

Run: `node --test test/job-state.test.mjs test/followup.test.mjs test/dashboard-client.test.mjs`
Expected: PASS.

- [ ] **Step 4: Dashboard client — statuses**

In `dashboard.mjs` client script:

Replace the `statusOf` const (line ~212):

```js
const STATUSES = ['viewed','applied','answered','interview','rejected'];
const POST_APPLIED = ['applied','answered','interview','rejected'];
const statusOf = (url) => { const s = entryOf(url).status; return STATUSES.includes(s) ? s : 'new'; };
```

In offline `patchEntry`, fix the `empty` check to use the list:

```js
    const empty = !(STATUSES.includes(e.status) || (e.note && e.note.length) || e.appliedAt);
```

In `setStatus`, `appliedAt` survives post-applied moves:

```js
async function setStatus(card, status){
  const url = card.dataset.url;
  const patch = { status };
  if (status === 'applied' && !entryOf(url).appliedAt) patch.appliedAt = new Date().toISOString();
  if (!POST_APPLIED.includes(status)) patch.appliedAt = null;
  await patchEntry(url, patch);
  renderCard(card); applyFilter(); renderFunnel();
}
```

In `renderCard`, the applied-ago stays visible through the funnel and the card gets a per-status class:

```js
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('applied', POST_APPLIED.includes(st));
  card.classList.toggle('rejected', st === 'rejected');
  ...
  if (ago) { if (POST_APPLIED.includes(st) && e.appliedAt) { ago.textContent = 'applied ' + daysAgo(e.appliedAt); ago.hidden = false; } else ago.hidden = true; }
```

- [ ] **Step 5: Dashboard markup — buttons, counts, funnel block**

Card `status-seg` (template ~line 85): add three buttons after Applied:

```html
        <button data-status="answered" onclick="setStatus(this.closest('.card'),'answered')">Answered</button>
        <button data-status="interview" onclick="setStatus(this.closest('.card'),'interview')">Interview</button>
        <button data-status="rejected" onclick="setStatus(this.closest('.card'),'rejected')">✗</button>
```

Header `filter-seg`: add after the Applied button:

```html
      <button data-filter="answered" onclick="setFilter('answered')">Answered <span class="cnt" id="cnt-answered">0</span></button>
      <button data-filter="interview" onclick="setFilter('interview')">Interview <span class="cnt" id="cnt-interview">0</span></button>
      <button data-filter="rejected" onclick="setFilter('rejected')">✗ <span class="cnt" id="cnt-rejected">0</span></button>
```

Header funnel line (after the `.toolbar` div):

```html
  <div class="funnel" id="funnel"></div>
```

In `applyFilter()`, extend the counts:

```js
  const counts = { all: 0, new: 0, viewed: 0, applied: 0, answered: 0, interview: 0, rejected: 0 };
  ...
  for (const k of ['all','new','viewed','applied','answered','interview','rejected']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }
```

Add `renderFunnel()` (next to `markFreshness`). "Answered" counts any post-applied movement — a rejection is a response too:

```js
function renderFunnel() {
  const bySrc = {};
  let applied = 0, answered = 0, interview = 0, rejected = 0;
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    if (!POST_APPLIED.includes(st)) return;
    applied++;
    const s = bySrc[card.dataset.source] = bySrc[card.dataset.source] || { a: 0, r: 0, i: 0 };
    s.a++;
    if (st !== 'applied') { answered++; s.r++; }
    if (st === 'interview') { interview++; s.i++; }
    if (st === 'rejected') rejected++;
  });
  const pct = (x, y) => y ? Math.round(x / y * 100) + '%' : '—';
  const src = Object.entries(bySrc).map(([k, s]) => k + ' ' + s.a + '/' + s.r + '/' + s.i).join(' · ');
  const el = document.getElementById('funnel');
  if (el) el.textContent = applied
    ? 'Funnel: ' + applied + ' applied → ' + answered + ' answered (' + pct(answered, applied) + ') → ' + interview + ' interview (' + pct(interview, answered) + ')' + (rejected ? ' · ' + rejected + ' rejected' : '') + (src ? '  ·  applied/answered/interview by source: ' + src : '')
    : '';
}
```

Call it from `init()` (after `applyFilter();` add `renderFunnel();`).

CSS additions:

```css
  .status-seg button.active[data-status="answered"] { background: #0969da; color: #fff; }
  .status-seg button.active[data-status="interview"] { background: #8250df; color: #fff; }
  .status-seg button.active[data-status="rejected"] { background: #cf222e; color: #fff; }
  .card.rejected { opacity: .45; }
  .funnel { font-size: 12px; color: #cdd9e5; margin-top: 6px; }
```

- [ ] **Step 6: Verify**

Run: `node --test test/` — all PASS.
Run: `node dashboard.mjs --open` with the state server running (`./open-dashboard.sh` or `node state-server.mjs &`).
Expected: cards show six status buttons; marking a card Answered/Interview/Rejected persists across a reload (check `job-state.json`); the funnel line appears in the header once at least one card is post-applied; `applied Xd ago` stays visible on answered/interview/rejected cards; follow-up reminders: `node followup.mjs` prints/updates nothing for rejected cards.

- [ ] **Step 7: Commit**

```bash
git add lib/job-state.mjs dashboard.mjs test/job-state.test.mjs test/followup.test.mjs test/dashboard-client.test.mjs
git commit -m "feat: funnel stages answered/interview/rejected + dashboard funnel summary"
```

---

### Task 7: Top-match notifications + docs

**Files:**
- Modify: `lib/run-summary.mjs` (add two pure helpers)
- Modify: `jobs.mjs` (one notify call at the end)
- Modify: `README.md` (document the four new features)
- Test: `test/run-summary.test.mjs` (extend)

**Interfaces:**
- Consumes: `writtenList: Array<{ score, llmScore, label }>` built in Task 3's phase B; `notify(msg)` already defined in `jobs.mjs`.
- Produces:
  - `topMatches(written) -> written[]` — entries with `llmScore >= 70` (when LLM-scored) or `score >= 40` (when not).
  - `formatTopMatches(matches) -> string` — one banner line, at most 3 labels, `""` for empty input.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-summary.test.mjs`:

```js
test("topMatches: llm-scored entries use the LLM threshold (70)", () => {
  const w = [
    { score: 45, llmScore: 71, label: "A" },  // in: llm >= 70
    { score: 45, llmScore: 69, label: "B" },  // out: llm verdict wins over keyword
    { score: 40, llmScore: null, label: "C" }, // in: keyword >= 40, no llm
    { score: 39, llmScore: null, label: "D" }, // out
  ];
  assert.deepEqual(topMatches(w).map((m) => m.label), ["A", "C"]);
});

test("formatTopMatches renders one line, caps at 3 labels", () => {
  assert.equal(formatTopMatches([]), "");
  assert.equal(formatTopMatches([{ label: "A @ X" }]), "🔥 Strong match: A @ X");
  assert.equal(
    formatTopMatches([{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }]),
    "🔥 4 strong matches: A, B, C, …",
  );
});
```

Add `topMatches, formatTopMatches` to the file's import from `../lib/run-summary.mjs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/run-summary.test.mjs`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `lib/run-summary.mjs`**

Append:

```js
// Top-match banner: the strongest freshly-written packages. An LLM-scored
// entry is judged by the LLM verdict alone; keyword score decides otherwise.
export const TOP_LLM = 70;
export const TOP_KEYWORD = 40;

export function topMatches(written) {
  return (written || []).filter((w) =>
    w.llmScore != null ? w.llmScore >= TOP_LLM : w.score >= TOP_KEYWORD,
  );
}

export function formatTopMatches(matches) {
  if (!matches.length) return "";
  const head = matches.length === 1 ? "Strong match" : `${matches.length} strong matches`;
  const labels = matches.slice(0, 3).map((m) => m.label).join(", ");
  return `🔥 ${head}: ${labels}${matches.length > 3 ? ", …" : ""}`;
}
```

- [ ] **Step 4: Wire into `jobs.mjs`**

Extend the run-summary import with `topMatches, formatTopMatches`. Then, right before the final `notify(formatNotification(summary));` line:

```js
// Separate banner for strong matches so they don't drown in the run digest.
const top = topMatches(writtenList);
if (top.length) notify(formatTopMatches(top));
```

- [ ] **Step 5: Verify**

Run: `node --test test/` — all PASS.
Run: `node --check jobs.mjs` — parses.

- [ ] **Step 6: Update `README.md`**

Add to the feature list / relevant sections (keep the README's existing tone, English):
- **LLM re-scoring & tailored cover letters** — under "Job discovery": the `llm` block in `jobs.config.json`, `claude -p` + haiku, never gates, silent fallback to keyword-only packages; dashboard 🤖 badge.
- **Funnel stages** — under "Dashboard v2": Applied → Answered → Interview / Rejected, header funnel line, follow-ups auto-silence past Applied.
- **Degradation alerts** — replace the current "warn if a source that had results returned 0" sentence with the median rule (10-run history, < 30% of median, median ≥ 5).
- **Top-match banner** — one line under the notifications/automation section.

- [ ] **Step 7: Commit**

```bash
git add lib/run-summary.mjs jobs.mjs test/run-summary.test.mjs README.md
git commit -m "feat: top-match notification banner after discovery runs; document the new features"
```
