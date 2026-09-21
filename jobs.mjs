// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board)
// and LinkedIn (scrape), scores them against your resume, and
// writes an application package for each RELEVANT match. IT NEVER SUBMITS
// ANYTHING — you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU + Djinni still run)

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage } from "./lib/relevance.mjs";
import { buildApplication, appendAltLink } from "./lib/application.mjs";
import { appendRunStat } from "./lib/run-stats.mjs";
import { llmJSON, buildJobPrompt, numericScore, llmRejects, injectionMarkers, sanitizeVacancyText } from "./lib/llm.mjs";
import { detectLang } from "./lib/lang.mjs";
import { dedupeJobs, identityKey, canonicalKey } from "./lib/dedup.mjs";
import { readPackages } from "./lib/packages.mjs";
import { filterByLocation, candidateCountryList, excludeList, knob as configKnob } from "./lib/filters.mjs";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatRunBanner,
} from "./lib/run-summary.mjs";
import { fetchDou } from "./lib/sources/dou.mjs";
import { fetchDjinni } from "./lib/sources/djinni.mjs";
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";
import { pool } from "./lib/sources/html.mjs";
import { currentCounts, normalizeHistory, detectDegradations, appendHistory, formatAlert } from "./lib/source-health.mjs";
import { log, notify as banner } from "./lib/notify.mjs";
import { launchBrowser, acquireProfileLock, LINKEDIN_LOGGED_OUT } from "./lib/browser.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { writeJsonAtomic, writeTextAtomic, readJson } from "./lib/json-file.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// Run-wide lock (jobs-run.lock/): two overlapping runs (launchd + manual) would
// both read jobs-seen.json, both write packages for the same vacancy, and the
// last save would drop the other's entries. Second run exits quietly — 0 so
// launchd does not flag it as a failure. Released on process exit.
try {
  acquireProfileLock(join(__dir, "jobs-run"));
} catch (e) {
  if (!/profile busy/.test(e.message)) throw e;
  log("another jobs.mjs run is active — exiting");
  process.exit(0);
}
const PROFILE = join(__dir, ".browser-profile");
const APPS = join(__dir, "applications");
// Fresh clone has no applications/ yet; readPackages/writeTextAtomic below need it.
mkdirSync(APPS, { recursive: true, mode: 0o700 });   // packages quote recruiter/job text — owner-only (mode applies at creation; existing dirs keep theirs)
const SEEN_FILE = join(__dir, "jobs-seen.json");
const HEALTH_FILE = join(__dir, "source-health.json");
const DOU_ONLY = process.env.DOU_ONLY === "1";

const config = JSON.parse(readFileSync(join(__dir, "jobs.config.json"), "utf8"));

// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
const RESUME_TXT = existsSync(join(__dir, "resume.txt")) ? readFileSync(join(__dir, "resume.txt"), "utf8") : "";
// Normalized once so the two gates that read it — the Djinni country filter and
// the LLM prompt — can never disagree (an empty/typo'd candidateCountry used to
// leave the filter rejecting everything while the prompt still said Ukraine).
const CANDIDATE_COUNTRY = candidateCountryList(config.candidateCountry);
const LLM = config.llm || {};
// Every numeric knob goes through here: a value that is not a number used to
// switch its gate off silently (`score < "abc"` is false for every score).
// It falls back to the default and says so once, in this run's log.
const knob = (name, v, fallback, range) => configKnob(name, v, fallback, range, log);
const MIN_SCORE = knob("minScore", config.minScore, 25);
// A source may set its own minScore — it overrides the global.
const SOURCE_MIN_SCORE = Object.fromEntries(["dou", "djinni", "linkedin"].map((s) => [s, knob(`${s}.minScore`, config[s]?.minScore, MIN_SCORE)]));
const LLM_MIN_SCORE = knob("llm.minScore", LLM.minScore, 0, [0, 100]);   // 0 = advisory-only, as when unset
const LLM_MAX_PER_RUN = knob("llm.maxPerRun", LLM.maxPerRun, 15, [1, Infinity]);   // 0 must not mean "defer everything forever"
const LLM_CONCURRENCY = knob("llm.concurrency", LLM.concurrency, 3, [1, Infinity]);   // 0 must not mean zero workers (every verdict empty, gate bypassed)
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;
if (LLM.enabled && !RESUME_TXT) log("llm: enabled in config but resume.txt is missing — LLM re-scoring off this run");

// A misspelt key is not a no-op, it is a silently different run: "llm" typo'd
// turns the whole LLM gate off (every keyword-passer gets a package) and a
// typo'd source name drops that source entirely — both with a clean log. Names
// we do not recognise are therefore reported rather than ignored. `_`-prefixed
// keys are the documentation blocks the shipped config is full of.
const KNOWN_TOP = new Set(["minScore", "requireRole", "candidateCountry", "excludeTitle", "excludeLocation", "llm", "dou", "djinni", "linkedin"]);
const KNOWN_LLM = new Set(["enabled", "model", "maxPerRun", "concurrency", "minScore"]);
const unknownIn = (obj, known) => Object.keys(obj || {}).filter((k) => !k.startsWith("_") && !known.has(k));
for (const k of unknownIn(config, KNOWN_TOP)) log(`⚠ config: unknown top-level key "${k}" — ignored (misspelt? known keys: ${[...KNOWN_TOP].join(", ")})`);
for (const k of unknownIn(LLM, KNOWN_LLM)) log(`⚠ config: unknown llm.${k} — ignored (misspelt? known keys: ${[...KNOWN_LLM].join(", ")})`);

const notify = (msg) =>
  banner("Job assistant", (msg || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Jobs ready");

// jobs-seen.json stores identity keys (normalize(company)+title) with a
// last-seen timestamp (90-day TTL), so a vacancy is "seen" regardless of
// source and the file stops growing forever.
const seen = loadSeenStore(SEEN_FILE);

// source-health.json keeps the last 10 runs' `found` counts per source so we
// can warn when a source degrades well below its recent norm (a likely sign
// its scraper broke). Missing/legacy file → normalized quietly.
// An UNREADABLE one is different: reading it as {} and then writing this run's
// counts back destroyed the baseline, and since the median rule needs 5 runs
// the alerting stayed silently off for the next five. Keep the file untouched
// and say so instead.
let health = {};
let healthReadable = true;
try {
  health = normalizeHistory(readJson(HEALTH_FILE, {}));
} catch (e) {
  healthReadable = false;
  log(`⚠ ${HEALTH_FILE} unreadable (${e.message}) — degradation alerting is off for this run and the file is left untouched; fix or delete it`);
}

let jobs = [];
// Exit status. Deliberately narrow: a run that gathered nothing because every
// source it TRIED threw is a failed run and launchd should see it, but a run
// where the sources worked and simply found no new vacancies is a healthy quiet
// run — the common case at night — and must stay exit 0. One source down out of
// several is also 0: source-health alerting already covers that, and flagging it
// here would make a single flaky board mark every run red.
let sourcesTried = 0, sourcesFailed = 0;
const RUN_STATS = join(__dir, "run-stats.jsonl");   // one line per run; the weekly digest reads this instead of parsing its own log
const summary = newSummary();

// Seniority terms we never apply to. Matched as whole words in the TITLE only,
// so a senior role whose description mentions "junior" (e.g. "mentor junior
// engineers") is kept, while "Junior AQA"/"QA Intern"/"Trainee QA" are dropped.
// Regexes compiled once at load, not per job. Same normalization as the two
// lists in lib/filters.mjs: a hand-edited excludeTitle that is not an array
// used to throw here, before a single job was gathered.
const EXCLUDE_TITLE = excludeList(config.excludeTitle).map((term) => ({
  term,
  re: new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i"),
}));
function excludedByTitle(title) {
  const t = (title || "").toLowerCase();
  return EXCLUDE_TITLE.find(({ re }) => re.test(t))?.term;
}

// Known before it is opened: already in the seen store (either key spelling) or
// excluded by title. LinkedIn skips the click + 1.8 s and Djinni the detail-page
// fetch for such jobs (most of every run); the scoring loop still re-stamps
// the seen entry because the job is returned from its list fields.
// ponytail: keys stamped before 2026-08-28 had + and # stripped ("c++" → "c");
// accept that spelling too until they age out of the 90-day TTL (~2026-11-28).
const legacyIdOf = (id) => id.replace(/[+#]+/g, " ").replace(/\s+/g, " ").trim();
const knownJob = (job) => { const id = identityKey(job); return seen.has(id) || seen.has(legacyIdOf(id)) || Boolean(excludedByTitle(job.title)); };

// 1–2) Browserless sources: DOU (RSS, always on), Djinni (public jobs board).
// Same gather/record/collect shape.
const BROWSERLESS_SOURCES = [
  { name: "dou", enabled: config.dou?.enabled !== false, fetch: fetchDou }, // on unless explicitly disabled
  { name: "djinni", enabled: config.djinni?.enabled, fetch: (cfg, lg) => fetchDjinni(cfg, lg, { skip: knownJob }) },
];
for (const s of BROWSERLESS_SOURCES) {
  // Say it out loud: a source turned off by a typo looked exactly like a source
  // that simply found nothing, and it never reached summary.sources so health
  // monitoring could not flag it either.
  if (!s.enabled) { log(`${s.name}: disabled in config — skipped`); continue; }
  log(`Gathering ${s.name}...`);
  sourcesTried++;
  try {
    const found = await s.fetch(config[s.name], log);
    recordFound(summary, s.name, found.length);
    jobs.push(...found);
  } catch (e) {
    sourcesFailed++;
    log(`${s.name} error:`, e.message);
    recordFound(summary, s.name, 0); // a hard failure must count as 0 so health monitoring alerts
  }
}

// 3) Browser source: LinkedIn (needs login) in a Playwright context. (Robota.ua,
// Work.ua and Glassdoor were dropped 2026-09-10: Cloudflare blocks them in
// headless Chrome and the owner does not want a visible window.)
const alerts = [];   // breakage lines for the single end-of-run banner (declared before the first push below)

// LinkedIn first checks the session: an expired login is a hard failure for
// health monitoring (found 0), not an exception.
async function fetchLinkedInChecked(page, cfg) {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
  if (LINKEDIN_LOGGED_OUT.test(page.url())) {
    log("⚠️  LinkedIn session expired — skipping LinkedIn jobs. Run: node login.mjs");
    alerts.push("⚠️ LinkedIn session expired — run: node login.mjs");
    return [];
  }
  log("Gathering LinkedIn jobs (scraping, modest)...");
  return fetchLinkedInJobs(page, cfg, log, { skip: knownJob });
}
if (DOU_ONLY) log("linkedin: skipped (DOU_ONLY=1)");
else if (!config.linkedin?.enabled) log("linkedin: disabled in config — skipped");
if (!DOU_ONLY && config.linkedin?.enabled) {
  let ctx;
  try {
    sourcesTried++;
    ctx = await launchBrowser(PROFILE); // inside try: a launch/lock failure logs + notifies instead of an unhandled rejection
    const page = ctx.pages()[0] || (await ctx.newPage());
    // Own try/catch so a scrape failure is logged and counted as 0 for health monitoring.
    try {
      const found = await fetchLinkedInChecked(page, config.linkedin);
      recordFound(summary, "linkedin", found.length);
      jobs.push(...found);
    } catch (e) { sourcesFailed++; log("LinkedIn error:", e.message); recordFound(summary, "linkedin", 0); }
  } catch (e) {
    log("Browser sources error:", e.message);
    // "profile busy" = benign overlap with check.mjs/login.mjs: no banner, and
    // no 0-count either — leaving the source out of the summary keeps a
    // skipped run from looking like a scraper outage to health monitoring.
    if (/profile busy/.test(e.message)) sourcesTried--;   // not an outage: the source was never tried
    else {
      sourcesFailed++;
      if (!ctx) notify(`Browser launch failed: ${e.message}`);
      // Launch/lock failure happens before the inner catch: record 0 so health monitoring sees the outage.
      if (!summary.sources.linkedin) recordFound(summary, "linkedin", 0);
    }
  } finally {
    // A throw here escapes the sibling catch and takes the whole run with it —
    // dedup, scoring and every package write included, after the scraping was
    // already paid for. Closing a browser is never worth that.
    try { await ctx?.close(); } catch (e) { log("browser close failed:", e.message); }
  }
}

log(`Total jobs gathered: ${jobs.length}`);

// Drop vacancies physically located abroad — applies to every source (DOU
// marks them "за кордоном", Djinni "Тільки офіс · Польща", etc).
{
  const before = jobs.length;
  const keptLoc = filterByLocation(jobs, config.excludeLocation, CANDIDATE_COUNTRY);
  if (keptLoc.length < before) {
    const kept = new Set(keptLoc);
    log(`Location filter: dropped ${before - keptLoc.length} foreign-location job(s)`);
    for (const j of jobs) if (!kept.has(j)) log(`  · location [${j.location}] ${j.source}: ${j.title}`);
  }
  jobs = keptLoc;
}

// Collapse the same vacancy arriving from multiple sources into one record
// (keeps the longest description, records the other source links in altLinks).
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
recordMerged(summary, mergedCount);
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);


// Canonical-key index of existing packages (cross-run dedup): the same vacancy
// resurfacing on ANOTHER board must not spawn a second package — its link is
// appended to the existing one instead. Same source = a distinct req, allowed.
const packageIndex = new Map();
for (const fm of readPackages(APPS, { warn: (f) => log(`  · unreadable package skipped: ${f}`) })) {
  // "—" is the blank-company placeholder; canonicalKey scopes those by url,
  // so pass the url along instead of filtering on a truthy company.
  // The url is carried too: "same source = a distinct req" is only true when
  // the URL differs. After a seen-store quarantine every live vacancy looks new
  // again, and without the url check each one got re-scored (a paid LLM call)
  // and written a SECOND time — the filename embeds a fresh minute stamp, so it
  // could never collide and the duplicate was invisible.
  if (fm.title) packageIndex.set(canonicalKey({ company: fm.company, title: fm.title, url: fm.url }), { file: fm.file, source: fm.source || "", url: fm.url || "" });
}

// 5a) Score all unseen jobs locally (cheap) and collect the gate-passers.
// Keyword gate: per-source/global minScore + requireRole. Passers go to 5b,
// where the LLM applies a second gate (llm.minScore).
let written = 0, considered = 0, llmFailed = 0, llmDropped = 0;
const matches = [];
for (const job of jobs) {
  const id = identityKey(job);
  const legacyId = legacyIdOf(id);
  // Re-stamp on every sighting so the TTL is "last seen", not "first seen" —
  // a vacancy still live after 90 days must not resurface as new.
  if (seen.has(id) || seen.has(legacyId)) { recordOutcome(summary, job.source, "seen"); seen.add(id); continue; }
  const existing = packageIndex.get(canonicalKey(job));
  // Same source AND same url = the very package we already wrote (the seen
  // store lost it, the package did not). Re-stamp and move on: no re-score, no
  // second file. A different url from the same source is still a distinct req.
  if (existing && existing.source === job.source && existing.url && existing.url === job.url) {
    log(`  · already packaged (${existing.file}) ${job.source}: ${job.title}`);
    recordOutcome(summary, job.source, "seen");
    seen.add(id);
    continue;
  }
  if (existing && existing.source !== job.source) {
    try { appendAltLink(join(APPS, existing.file), job.source, job.url); }
    catch (e) { log(`  · alt-link append failed (${existing.file}): ${e.message}`); }
    log(`  · dup-of-existing (${existing.file}) ${job.source}: ${job.title}`);
    recordOutcome(summary, job.source, "seen");
    seen.add(id);
    continue;
  }
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
  const minScore = SOURCE_MIN_SCORE[job.source] ?? MIN_SCORE;
  const needRole = config.requireRole ? Boolean(scored.matchedRole) : true;
  if (scored.score < minScore || !needRole) {
    // A card whose description failed to load (LinkedIn panel timeout) scores
    // on its title alone; marking it seen would bury it for the 90-day TTL.
    // Leave it unseen so the next run re-reads the description.
    const noDesc = (job.text || "").length < 300;
    log(`  · skip [${scored.score}${scored.matchedRole ? "" : " no-role"}] ${job.source}: ${job.title}${noDesc ? " (no description — will retry)" : ""}`);
    recordOutcome(summary, job.source, "low");
    if (!noDesc) seen.add(id);
    continue;
  }
  matches.push({ id, job, scored });
}

// 5b) Strongest keyword matches first: LLM re-score + tailored letter (capped
// per run), then write the package. LLM fit below llm.minScore → dropped;
// LLM failure → keyword-only package; past the per-run cap → deferred to the
// next run (not written, not marked seen) so the weakest matches — the likeliest
// false positives — never bypass the LLM gate.
matches.sort((a, b) => b.scored.score - a.scored.score);
const writtenList = [];
const label = (job) => `${job.title} @ ${job.company}`;
const toScore = llmOn ? matches.slice(0, LLM_MAX_PER_RUN) : matches;
for (const { job, scored } of matches.slice(toScore.length)) {
  log(`  · deferred [${scored.score}] ${job.source}: ${label(job)} — llm.maxPerRun reached, next run`);
}
// Score a few CLI calls at a time (~20 s each on sonnet, ~55 s on haiku; 15 in
// sequence used to take 14 min) while the loop below consumes verdicts in score
// order and writes each package as soon as its verdict is in — so a crash or a
// sleeping Mac mid-scoring keeps every package already paid for, exactly like
// the old sequential loop.
const verdict = new Map();   // m → Promise<llm result | null>
let scoring = Promise.resolve();
if (llmOn) {
  const resolvers = new Map(toScore.map((m) => { let res; verdict.set(m, new Promise((r) => { res = r; })); return [m, res]; }));
  scoring = pool(toScore, LLM_CONCURRENCY, async (m) => {
    // Every promise must settle. A throw in here used to leave `await
    // verdict.get(m)` pending forever — the run deadlocked mid-scoring with an
    // unhandled rejection on `scoring` — so a failure resolves null, which the
    // consumer already treats as "llm failed, keyword-only package".
    try {
      resolvers.get(m)(await llmJSON(buildJobPrompt(RESUME_TXT, m.job, detectLang(m.job.text), { country: CANDIDATE_COUNTRY[0] }), { model: LLM.model || "sonnet", log }));
    } catch (e) {
      log(`  · llm threw for: ${m.job.title} — ${e?.message}`);
      resolvers.get(m)(null);
    }
  });
}
for (const m of toScore) {
  const { id, job, scored } = m;
  const lbl = label(job);
  let llm = null;
  if (llmOn) {
    const res = await verdict.get(m);
    // Normalize the score once at the trust boundary; downstream (log,
    // package frontmatter, writtenList) can rely on a rounded number.
    const n = res ? numericScore(res.score) : null;
    if (n !== null) {
      // `score` was the only model-controlled field bounded here; `why` and
      // `red_flags` went into the package verbatim, so a posting could steer
      // the model into writing an arbitrarily long line there (fmValue keeps it
      // to one line, but not to a sane length). Bound everything that crosses.
      // Built as an explicit allow-list, NOT `{...res}`: the spread carried
      // every other key of the model's JSON through verbatim, so a posting
      // could have the model emit its own `suspect` ("verified clean") and
      // forge the very field that exists to warn about it. These six are the
      // only keys anything downstream reads.
      llm = {
        score: Math.min(100, Math.max(0, Math.round(n))),
        why: String(res.why ?? "").slice(0, 300),
        red_flags: (Array.isArray(res.red_flags) ? res.red_flags : []).slice(0, 10).map((f) => String(f).slice(0, 200)),
        cover: typeof res.cover === "string" ? res.cover : "",
        model: LLM.model || "sonnet",
      };
      // A posting that talks to the screener may well have talked it into this
      // score. Record that alongside the number instead of letting an inflated
      // score look like an ordinary good match. Scan the SANITIZED text: it is
      // what the model actually saw, and composeText builds job.text as
      // "<title> at <company>. <location>. <desc>", so every field
      // buildJobPrompt puts in the prompt is already in here. Scanning the raw
      // field let a posting split a payload with "<vacancy>" tokens and slip
      // past the markers while the model read the reassembled sentence.
      // (Reviewed 2026-09-17: passing the fields in separately as well only
      // double-counts the markers and inflates the suspect line.)
      const marks = injectionMarkers(sanitizeVacancyText(job.text));
      if (marks.length) { llm.suspect = `injection (${marks.length} marker${marks.length === 1 ? "" : "s"})`; log(`  · ⚠ vacancy text addresses the screener — flagged: ${job.title}`); }
    }
    else { llmFailed++; log(`  · llm failed for: ${job.title} — keyword-only package`); }
  }
  if (llmRejects(llm, LLM_MIN_SCORE)) {
    llmDropped++;
    log(`  · skip [${scored.score} / llm ${llm.score}] ${job.source}: ${lbl}`);
    recordOutcome(summary, job.source, "low");
    seen.add(id);   // persisted with the next written package, or at the end of the loop
    continue;
  }
  // Skip the one package the way every other per-item failure in this loop
  // does. Unwrapped, a single ENOSPC/EACCES threw mid-loop and took the rest of
  // the run with it: the remaining matches, run stats, source health, the
  // dashboard refresh and the end-of-run banner.
  // buildApplication is INSIDE the try, not one line above it: composing the
  // package is per-item work too, and a throw there (a scraped field of an
  // unexpected shape) had the whole blast radius this try exists to prevent.
  let filename, markdown;
  try {
    ({ filename, markdown } = buildApplication(job, scored, llm));
    writeTextAtomic(join(APPS, filename), markdown);   // a crash mid-write must not leave a frontmatter-less package
  } catch (e) {
    log(`  · package build/write failed (${filename || lbl}): ${e.message}`);
    continue;
  }
  log(`  ✓ MATCH [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${lbl}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, lbl);
  writtenList.push({ score: scored.score, llmScore: llm ? llm.score : null, label: lbl });
  seen.add(id);
  // Persist after every WRITTEN package: a crash mid-run must not forget one
  // (the next run would re-score and re-pay the LLM for it). Each save
  // rewrites and fsyncs the whole store, so the drop path above does not
  // pay for it — a dropped id lost to a crash costs one repeated verdict.
  seen.save();
  written++;
}
await scoring;   // every worker has finished (all verdicts were consumed above; this just joins the pool)

seen.save();

// The weekly digest used to reconstruct these four numbers by regex-matching the
// log lines above — anchored to their exact wording and leading-space count, so
// rewording any of them silently zeroed the report (it already happened once, at
// the run.sh rename). The run records them itself now; report.mjs prefers this
// file and keeps the log parser only for the history written before it existed.
//
// Written BEFORE the "Done." line, not after: report.mjs asks the log parser
// only for the time before its first stat entry, and the log line used to land a
// few milliseconds ahead of the stat it belongs to — so the very first run after
// the file is created (or rotated) fell inside that window and was counted
// twice, once from each source. Writing the stat first makes the ordering
// deterministic in the direction that cannot double-count.
appendRunStat(RUN_STATS, { considered, written, dropped: llmDropped, failed: llmFailed });
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));

// Scraper-health: alert if a source came in far below its recent norm, then
// append this run's counts to the history. An LLM failing more than twice in
// one run is a breakage too (a single flake is not).
const degraded = detectDegradations(health, summary);
if (degraded.length) alerts.push(formatAlert(degraded));
if (llmFailed > 2) alerts.push(`⚠️ LLM failed ${llmFailed}× — keyword-only packages`);
// Never write back a baseline we could not read: that is the silent reset.
if (healthReadable) writeJsonAtomic(HEALTH_FILE, appendHistory(health, currentCounts(summary)));

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore", timeout: 60_000 });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

// One banner per run: breakage alerts + the new packages. Silent when neither.
const bannerText = formatRunBanner(writtenList, alerts);
if (bannerText) notify(bannerText);
// launchd must see a failed run as failed (the convention djinni-check.mjs:144
// already follows). "Failed" is only "every source we tried threw" — a quiet
// run that gathered nothing because there was nothing new stays 0.
const runFailed = sourcesTried > 0 && sourcesFailed === sourcesTried;
if (runFailed) log(`All ${sourcesTried} source(s) failed — exiting 1 so the scheduler sees it`);
process.exit(runFailed ? 1 : 0);
