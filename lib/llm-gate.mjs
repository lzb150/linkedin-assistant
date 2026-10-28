// The LLM gate of jobs.mjs, step 5b: strongest keyword matches first, LLM
// re-score + tailored letter (capped per run), then the package write.
//
//   judgeMatches(matches, deps) → { written, borderline, writtenList, llmFailed, llmDropped, llmDeferred, llmFallback, llmCalls, llmMs }
//
// LLM fit below llm.minScore → dropped, unless it is at or above
// llm.borderlineMin: then a `tier: borderline` package (a muted dashboard tab,
// no Telegram message). LLM failure → deferred once, borderline package on the
// second failure (keyword-only when the gate is advisory); past the per-run cap → deferred to the next
// run (not written, not marked seen) so the weakest matches — the likeliest
// false positives — never bypass the LLM gate. `judge` is injectable (defaults
// to the hardened claude -p wrapper) so the gate can be exercised without a CLI.
import { join } from "node:path";
import { llmJSON, buildJobPrompt, numericScore, llmRejects, injectionMarkers, sanitizeVacancyText } from "./llm.mjs";
import { detectLang } from "./lang.mjs";
import { buildApplication } from "./application.mjs";
import { writeTextAtomic } from "./json-file.mjs";
import { pool } from "./sources/html.mjs";
import { recordOutcome, recordTop } from "./run-summary.mjs";
import { queueTelegram, jobMessage } from "./telegram.mjs";

const label = (job) => `${job.title} @ ${job.company}`;

export async function judgeMatches(matches, {
  llm: { on, minScore, borderlineMin = 0, maxPerRun, concurrency, model = "sonnet", resume, country, timeoutMs },
  seen, stamp, titleOnlyNo, summary, appsDir, log, judge = llmJSON,
}) {
  // llmCalls/llmMs: every judge() call, verdict or not, for the digest's average latency.
  const run = { written: 0, borderline: 0, writtenList: [], llmFailed: 0, llmDropped: 0, llmDeferred: 0, llmFallback: 0, llmCalls: 0, llmMs: 0 };
  // The band exists only under a real gate: with minScore 0 nothing is ever
  // dropped, so there is nothing to be borderline to.
  const bandOn = minScore > 0 && borderlineMin > 0 && borderlineMin < minScore;
  const toScore = capPerRun(matches, { on, maxPerRun }, log);
  // Score a few CLI calls at a time (~20 s each on sonnet, ~55 s on haiku; 15 in
  // sequence used to take 14 min) while the loop below consumes verdicts in score
  // order and writes each package as soon as its verdict is in — so a crash or a
  // sleeping Mac mid-scoring keeps every package already paid for, exactly like
  // the old sequential loop.
  const verdict = new Map();   // m → Promise<llm result | null>
  const scoring = on ? scoreInPool(toScore, verdict, { concurrency, resume, country, model, timeoutMs, log, judge }, run) : Promise.resolve();
  const ctx = { minScore, borderlineMin, bandOn, model, seen, stamp, titleOnlyNo, summary, appsDir, log, run };
  for (const m of toScore) {
    const judged = on ? takeVerdict(m, await verdict.get(m), ctx) : { llm: null, suspect: null, tier: undefined };
    if (judged) gate(m, judged, ctx);
  }
  await scoring;   // every worker has finished (all verdicts were consumed above; this just joins the pool)
  saveSeen(seen, log);
  return run;
}

// Strongest keyword matches first; past llm.maxPerRun the rest wait for the next run.
function capPerRun(matches, { on, maxPerRun }, log) {
  matches.sort((a, b) => b.scored.score - a.scored.score);
  const toScore = on ? matches.slice(0, maxPerRun) : matches;
  for (const { job, scored } of matches.slice(toScore.length)) {
    log(`  · deferred [${scored.score}] ${job.source}: ${label(job)} — llm.maxPerRun reached, next run`);
  }
  return toScore;
}

function scoreInPool(toScore, verdict, { concurrency, resume, country, model, timeoutMs, log, judge }, run) {
  // One deferred promise per match: the pool settles it, the loop awaits it.
  // (Promise.withResolvers is Node 22+; CI also runs 20.)
  const resolvers = new Map();
  for (const m of toScore) verdict.set(m, new Promise((resolve) => resolvers.set(m, resolve)));
  return pool(toScore, concurrency, async (m) => {
    // Every promise must settle. A throw in here used to leave `await
    // verdict.get(m)` pending forever — the run deadlocked mid-scoring with an
    // unhandled rejection on `scoring` — so a failure resolves null, which the
    // consumer already treats as "llm failed".
    const t0 = Date.now();
    run.llmCalls++;
    try {
      resolvers.get(m)(await judge(buildJobPrompt(resume, m.job, detectLang(m.job.text), { country }), { model, log, timeoutMs }));
    } catch (e) {
      log(`  · llm threw for: ${m.job.title} — ${e?.message}`);
      resolvers.get(m)(null);
    } finally {
      run.llmMs += Date.now() - t0;
    }
  });
}

// Guarded like the package write: an ENOSPC/EIO here used to throw out
// of the loop (with LLM workers still running) and take run stats, source
// health, the dashboard refresh and the banner with it. A failed save only
// costs repeated verdicts next run; the final call retries it.
function saveSeen(seen, log) {
  try { seen.save(); } catch (e) { log(`  · jobs-seen.json save failed: ${e.message}`); }
}

// The match's LLM result as { llm, suspect, tier }, or null when a first
// failure defers it to the next run.
function takeVerdict({ id, job }, res, { seen, minScore, model, log, run }) {
  // Normalize the score once at the trust boundary; downstream (log,
  // package frontmatter, writtenList) can rely on a rounded number.
  const n = res ? numericScore(res.score) : null;
  const suspect = injectionFlag(job, log);
  if (n !== null) return { llm: boundVerdict(res, n, model), suspect, tier: undefined };
  run.llmFailed++;
  // No verdict is not a verdict. A failed call used to write the keyword-only
  // package at once — so a 180 s timeout on a busy Mac let the match skip the
  // LLM gate for good, with the generic cover note (19 of 64 real packages by
  // 2026-10-22, "AQA Lead" and "Project Manager with QA Automation" among
  // them). Now the first failure leaves the job unseen for the next run, like
  // llm.maxPerRun; only a SECOND failure writes the keyword-only package, so
  // a real outage still never loses a match. `llm-retry:` keys never read as
  // seen (keywordGate checks the bare id).
  const retryKey = `llm-retry:${id}`;
  if (!seen.has(retryKey)) {
    seen.add(retryKey);
    run.llmDeferred++;
    log(`  · llm failed for: ${job.title} — deferred, next run`);
    return null;
  }
  run.llmFallback++;
  // Under a real gate the unjudged package goes to the borderline tab: 4 of
  // DOU's last 5 keyword-only packages were titles the owner excludes.
  const tier = minScore > 0 ? "borderline" : undefined;
  log(`  · llm failed again for: ${job.title} — keyword-only package${tier ? " (borderline)" : ""}`);
  return { llm: null, suspect, tier };
}

// A posting that talks to the screener may well have talked it into this
// score — or into no usable answer at all, which falls back to a
// keyword-only package. Either way the warning goes with the package.
// Scan the SANITIZED text: it is what the model actually saw, and
// composeText builds job.text as "<title> at <company>. <location>. <desc>",
// so every field buildJobPrompt puts in the prompt is already in here.
// Scanning the raw field let a posting split a payload with "<vacancy>"
// tokens and slip past the markers while the model read the reassembled
// sentence. (Reviewed 2026-09-17: passing the fields in separately as well
// only double-counts the markers and inflates the suspect line.)
function injectionFlag(job, log) {
  const marks = injectionMarkers(sanitizeVacancyText(job.text));
  if (!marks.length) return null;
  log(`  · ⚠ vacancy text addresses the screener — flagged: ${job.title}`);
  return `injection (${marks.length} marker${marks.length === 1 ? "" : "s"})`;
}

// `score` was the only model-controlled field bounded here; `why` and
// `red_flags` went into the package verbatim, so a posting could steer
// the model into writing an arbitrarily long line there (fmValue keeps it
// to one line, but not to a sane length). Bound everything that crosses.
// Built as an explicit allow-list, NOT `{...res}`: the spread carried
// every other key of the model's JSON through verbatim, so a posting
// could have the model emit its own `suspect` ("verified clean") and
// forge the very field that exists to warn about it. These five are the
// only verdict keys anything downstream reads; `suspect` is ours alone.
function boundVerdict(res, n, model) {
  return {
    score: Math.min(100, Math.max(0, Math.round(n))),
    why: String(res.why ?? "").slice(0, 300),
    red_flags: (Array.isArray(res.red_flags) ? res.red_flags : []).slice(0, 10).map((f) => String(f).slice(0, 200)),
    cover: typeof res.cover === "string" ? res.cover : "",
    model,
  };
}

// Drop the match, or write its package as borderline or as a match.
function gate(m, { llm, suspect, tier }, ctx) {
  const { minScore, bandOn, borderlineMin } = ctx;
  if (llmRejects(llm, minScore) && bandOn && llm.score >= borderlineMin) tier = "borderline";
  if (llmRejects(llm, minScore) && !tier) return drop(m, llm, ctx);
  const pkg = writePackage(m, llm, { suspect, tier }, ctx);
  if (!pkg) return;
  if (tier === "borderline") return fileBorderline(m, llm, ctx);
  fileMatch(m, llm, pkg.salary, ctx);
}

function drop({ id, job, scored, retry }, llm, { summary, stamp, titleOnlyNo, log, run }) {
  run.llmDropped++;
  log(`  · skip [${scored.score} / llm ${llm.score}] ${job.source}: ${label(job)}${retry ? " (no description — will retry)" : ""}`);
  recordOutcome(summary, job.source, "low");
  // Judged on its title alone: the LLM's "no" is not a verdict on the job yet.
  if (retry) titleOnlyNo(job, id, "llm");
  else stamp(job, id);   // persisted with the next written package, or at the end of the loop
}

// Skip the one package the way every other per-item failure in this loop
// does. Unwrapped, a single ENOSPC/EACCES threw mid-loop and took the rest of
// the run with it: the remaining matches, run stats, source health, the
// dashboard refresh and the end-of-run banner.
// buildApplication is INSIDE the try, not one line above it: composing the
// package is per-item work too, and a throw there (a scraped field of an
// unexpected shape) had the whole blast radius this try exists to prevent.
function writePackage({ job, scored }, llm, { suspect, tier }, { appsDir, log }) {
  let filename, markdown, salary;
  try {
    ({ filename, markdown, salary } = buildApplication(job, scored, llm, { suspect, tier, repost: job.repost }));
    writeTextAtomic(join(appsDir, filename), markdown);   // a crash mid-write must not leave a frontmatter-less package
  } catch (e) {
    log(`  · package build/write failed (${filename || label(job)}): ${e.message}`);
    return null;
  }
  return { salary };
}

// Written, seen, counted — but not announced: the phone and the banner are
// for matches, and the tab is where a borderline card waits to be looked at.
function fileBorderline({ id, job, scored }, llm, { summary, stamp, seen, log, run }) {
  const lbl = label(job);
  log(`  ~ BORDERLINE [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${lbl}`);
  recordOutcome(summary, job.source, "borderline");
  run.writtenList.push({ score: scored.score, llmScore: llm ? llm.score : null, label: lbl, tier: "borderline" });
  stamp(job, id);
  saveSeen(seen, log);
  run.borderline++;
}

function fileMatch({ id, job, scored }, llm, salary, { summary, stamp, seen, log, run }) {
  const lbl = label(job);
  log(`  ✓ MATCH [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${lbl}${job.repost ? ` (repost ×${job.repost.reposts})` : ""}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, lbl);
  run.writtenList.push({ score: scored.score, llmScore: llm ? llm.score : null, label: lbl });
  // The phone gets each package as its own message, linked to the vacancy
  // (a no-op unless telegram.json is set up). `salary` is the one the package
  // was built from — extracted once, not scanned again here.
  queueTelegram(jobMessage({
    title: job.title, company: job.company, location: job.location, source: job.source, url: job.url,
    salary, posted: job.posted, reposts: job.repost?.reposts,
    score: scored.score, llmScore: llm ? llm.score : null, why: llm?.why, redFlags: llm?.red_flags,
  }));
  stamp(job, id);
  // Persist after every WRITTEN package: a crash mid-run must not forget one
  // (the next run would re-score and re-pay the LLM for it). Each save
  // rewrites and fsyncs the whole store, so the drop path does not
  // pay for it — a dropped id lost to a crash costs one repeated verdict.
  saveSeen(seen, log);
  run.written++;
}
