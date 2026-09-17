// The LLM re-scoring stage of a jobs run, as one module.
//
// jobs.mjs used to hold all of it inline: the maxPerRun slice, a pool of
// workers, a Map of hand-rolled promise resolvers, the try/catch that turns a
// throw into a null verdict, the score clamping and the injection flag — about
// 40 lines whose failure modes (a throw leaving `await verdict.get(m)` pending
// forever and deadlocking the run; a bad `concurrency` leaving zero workers and
// silently bypassing the gate) all had to be proven through the e2e test.
//
// The caller now sees: which items are scored, which are deferred, and one
// `verdictFor(item)` that resolves to a ready-to-write verdict or null. Scoring
// runs in the background while the caller consumes verdicts IN SCORE ORDER and
// writes each package as its verdict lands — so a crash or a sleeping Mac
// mid-scoring keeps every package already paid for.

import { pool } from "./pool.mjs";
import { llmJSON, buildJobPrompt, numericScore, injectionMarkers } from "./llm.mjs";
import { detectLang } from "./lang.mjs";

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_PER_RUN = 15;
const DEFAULT_CONCURRENCY = 3;

// jobs.config.json is hand-edited: "0", "abc" and a missing key must all fall
// back to the default rather than mean "defer everything forever" (maxPerRun)
// or "run zero workers" (concurrency).
const positive = (v, fallback) => Math.max(1, Number(v) || fallback);

/**
 * @param matches  [{ job, ... }] best keyword score first — the order verdicts are consumed in
 * @param resume   resume.txt; empty disables the gate for this run
 * @param llm      config.llm ({ enabled, model, minScore, maxPerRun, concurrency })
 * @param country  candidate country for the prompt
 * @param call     injectable llmJSON, for tests
 * @returns {{ scored, deferred, verdictFor, failures, done }}
 *   scored/deferred — the split by maxPerRun (`deferred` is not scored, not written, not seen)
 *   verdictFor(m)   — Promise of the normalized verdict, or null when the call
 *                     failed OR the gate is off: both mean "keyword-only package"
 *   failures()      — LLM calls that produced no verdict (read after consuming)
 *   done            — resolves when every worker has finished
 */
export function startLlmScoring(matches, { resume = "", llm = {}, country, log = () => {}, call = llmJSON } = {}) {
  const enabled = Boolean(llm.enabled) && resume.length > 0;
  if (!enabled) {
    return { scored: matches, deferred: [], verdictFor: async () => null, failures: () => 0, done: Promise.resolve() };
  }

  const model = llm.model || DEFAULT_MODEL;
  const scored = matches.slice(0, positive(llm.maxPerRun, DEFAULT_MAX_PER_RUN));
  const deferred = matches.slice(scored.length);

  let failures = 0;
  const verdicts = new Map();   // m -> Promise<verdict | null>
  const resolvers = new Map(scored.map((m) => {
    let resolve;
    verdicts.set(m, new Promise((r) => { resolve = r; }));
    return [m, resolve];
  }));

  const done = pool(scored, positive(llm.concurrency, DEFAULT_CONCURRENCY), async (m) => {
    // Every promise must settle. A throw in here used to leave the consumer's
    // await pending forever — the run deadlocked mid-scoring with an unhandled
    // rejection — so a failure resolves null, which the consumer already treats
    // as "LLM failed, write the keyword-only package".
    let res = null;
    try {
      const prompt = buildJobPrompt(resume, m.job, detectLang(m.job.text), { country });
      res = await call(prompt, { model, log });
    } catch (e) {
      log(`  · llm threw for: ${m.job.title} — ${e?.message}`);
    }
    resolvers.get(m)(normalize(res, m.job, { model, log, onFailure: () => { failures++; } }));
  });

  return { scored, deferred, verdictFor: (m) => verdicts.get(m) ?? Promise.resolve(null), failures: () => failures, done };
}

// Normalize at the trust boundary so everything downstream — the log line, the
// package frontmatter, the banner — can rely on a rounded 0..100 number.
function normalize(res, job, { model, log, onFailure }) {
  const n = res ? numericScore(res.score) : null;
  if (n === null) {
    onFailure();
    log(`  · llm failed for: ${job.title} — keyword-only package`);
    return null;
  }
  const verdict = { ...res, score: Math.min(100, Math.max(0, Math.round(n))), model };
  // A posting that talks to the screener may well have talked it into this
  // score. Record that beside the number instead of letting an inflated score
  // look like an ordinary good match.
  const marks = injectionMarkers(job.text);
  if (marks.length) {
    verdict.suspect = `injection (${marks.length} marker${marks.length === 1 ? "" : "s"})`;
    log(`  · ⚠ vacancy text addresses the screener — flagged: ${job.title}`);
  }
  return verdict;
}
