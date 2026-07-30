# LLM scoring, funnel stages & source reliability — design

Date: 2026-07-30
Status: approved

## Goal

Close the four friction points the user named: too much irrelevant noise on the
dashboard, hand-rewriting template cover letters, no view of the application
funnel, and forgetting to open the dashboard at all. Plus: the LinkedIn source
has silently decayed (source-health 6 vs 46–55 for the other sources) and
nothing alerted, because the current health check only fires on a drop to zero.

Approach chosen: incremental — five independent features sharing one tiny LLM
helper. Keyword scoring stays as the cheap gate/pre-filter; the LLM ranks and
annotates on top. Everything must keep working when the LLM is unavailable.

## 1. LLM helper — `lib/llm.mjs`

One exported function:

```
llmJSON(prompt, { timeoutMs = 60_000 } = {}) -> object | null
```

- Spawns `claude -p` (the locally installed Claude CLI — no separate API key)
  with a configured model (default `haiku`: cheap, fast, good enough for
  scoring and short letters).
- The prompt instructs "respond with JSON only"; the helper extracts the first
  `{…}` block and `JSON.parse`s it.
- Returns `null` on ANY failure: CLI not installed, non-zero exit, timeout,
  unparseable output. Never throws. Callers treat `null` as "LLM off".

Config lives in `jobs.config.json`:

```json
"llm": {
  "enabled": true,
  "model": "haiku",
  "minKeywordScore": 15,
  "maxPerRun": 15
}
```

`enabled: false` (or a missing block) disables all LLM calls.

## 2. LLM re-scoring in `jobs.mjs`

- Keyword scoring runs first, unchanged. It remains the sole gate for cold
  applications (`minScore` + `requireRole` untouched).
- Jobs whose keyword score ≥ `llm.minKeywordScore` are sent to the LLM, capped
  at `llm.maxPerRun` per run (highest keyword scores first) to bound cost and
  runtime.
- Prompt: candidate resume (`resume.txt`) + job title/company/description →
  strict JSON `{ "score": 0-100, "why": "<one line>", "red_flags": ["…"] }`.
- Result is written into the application package frontmatter as `llm_score`
  and `llm_why` (red flags folded into `llm_why` when present).
- Dashboard sorts by `llm_score` when present, falling back to the keyword
  score; each card shows an LLM badge (score + the one-line "why").
- The LLM never gates: if `llmJSON` returns `null`, packages are built exactly
  as today. No behavior change when offline.

## 3. LLM cover letters in `lib/application.mjs`

- When the LLM is available, the cover letter is generated per job: written in
  the job's language (reuse `detectLang`), grounded in `resume.txt` and the
  matched skills, ≤ ~150 words, no filler.
- The existing per-language templates stay as the fallback (LLM `null` →
  template, exactly today's output).
- Unchanged principle: drafts are only written to disk; nothing is ever sent.

## 4. Source degradation alerts — `lib/source-health.mjs`

Today `source-health.json` stores one number per source and alerts only when a
source drops to exactly zero. A slow decay (LinkedIn: 6 vs a norm of ~50) is
invisible.

- New format: `{ "<source>": [count, count, …] }` — the found-counts of the
  last 10 runs (newest last). Migration: a legacy flat number becomes a
  one-element history on first load.
- Degradation rule: alert when the current run's `found` < 30% of the median
  of the stored history, and that median ≥ 5 (avoids noise on tiny sources).
  The existing drop-to-zero alert is subsumed by this rule.
- Alert delivery: the existing `notify()` osascript banner plus the run log,
  same as today's zero alert.
- Pure functions in `lib/source-health.mjs`; file I/O stays in `jobs.mjs`.

## 5. Funnel stages & dashboard summary

- `lib/job-state.mjs`: `STATUSES` grows from `viewed, applied` to
  `viewed, applied, answered, interview, rejected` ("new" stays virtual).
  Existing normalize/merge/validate logic handles the new values with no
  structural change.
- Dashboard card: the status control offers the new stages after Applied.
- `followup.mjs` needs no change: it already filters `status === "applied"`,
  so moving a job to answered/interview/rejected silences its reminder
  naturally.
- Dashboard header gains a funnel block, computed at render time from
  `job-state.json` + packages: counts and conversion percentages for
  Applied → Answered → Interview, with a per-source breakdown (which boards
  actually convert).

## 6. Top-match notifications in `jobs.mjs`

- After a discovery run, if new packages were created with `llm_score ≥ 70`
  (or keyword score ≥ 40 when the LLM is off), post ONE osascript banner via
  the existing `notify()`: e.g. `3 strong matches: Senior AQA @ Acme, …`.
- No repeat-suppression state needed: `jobs-seen.json` already guarantees a
  package is created at most once per vacancy.

## Error handling

- LLM: every failure path returns `null` → keyword-only behavior. No retries
  (next run retries naturally).
- Notifications: best-effort, never throw (existing `notify()` contract).
- Health history: unreadable/corrupt `source-health.json` → start fresh, no
  alert that run.

## Testing

Small `node:test` files in `test/`, mirroring the existing style:

- `llm.test.mjs` — JSON extraction from noisy output, null on garbage/timeout
  (spawn stubbed).
- `source-health.test.mjs` — extend: history append/trim, median-degradation
  math, legacy-format migration.
- `job-state.test.mjs` — extend: new statuses accepted, legacy entries intact.
- `dashboard` funnel counting — pure function test for stage/source tallies.

Live `claude -p` calls are not tested in CI; the helper is exercised via stubs.

## Implementation order

1. `lib/llm.mjs` + re-scoring (sections 1–2)
2. LLM cover letters (section 3)
3. Source degradation alerts (section 4)
4. Funnel stages + dashboard summary (section 5)
5. Top-match notifications (section 6)

Each step is independently shippable; nothing depends on a later step.
