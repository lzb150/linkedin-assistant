// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board),
// Himalayas (JSON API), public Telegram channels (web preview) and LinkedIn
// (scrape), scores them against your resume, and
// writes an application package for each RELEVANT match. IT NEVER SUBMITS
// ANYTHING — you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU, Djinni, Himalayas and Telegram still run)
//       LINKEDIN_CATCHUP=1 node jobs.mjs  (LinkedIn only, and only when a DarkWake run deferred it)

import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keywordGate, titleExcluder, seenEither } from "./lib/keyword-gate.mjs";
import { appendAltLink } from "./lib/application.mjs";
import { appendRunStat } from "./lib/run-stats.mjs";
import { dedupeJobs, identityKey, canonicalKey, linkKey } from "./lib/dedup.mjs";
import { readPackages } from "./lib/packages.mjs";
import { filterByLocation, excludeList } from "./lib/filters.mjs";
import { readJobsConfig, normalizeJobsConfig } from "./lib/jobs-config.mjs";
import { newSummary, recordFound, recordOutcome, recordMerged, formatTable, formatRunBanner } from "./lib/run-summary.mjs";
import { fetchDou } from "./lib/sources/dou.mjs";
import { fetchDjinni } from "./lib/sources/djinni.mjs";
import { fetchHimalayas } from "./lib/sources/himalayas.mjs";
import { fetchTgChannels } from "./lib/sources/tgchannels.mjs";
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";
import { currentCounts, normalizeHistory, detectDegradations, appendHistory, formatAlert } from "./lib/source-health.mjs";
import { log, notify as banner } from "./lib/notify.mjs";
import { queueTelegram, alertMessage } from "./lib/telegram.mjs";
import { launchBrowser, acquireProfileLock, closeBounded, LINKEDIN_LOGGED_OUT } from "./lib/browser.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { judgeMatches } from "./lib/llm-gate.mjs";
import { writeJsonAtomic, readJson } from "./lib/json-file.mjs";
import { darkWakeOnBattery } from "./lib/wake.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// LinkedIn deferred by a DarkWake run (see lib/wake.mjs). The marker is the
// whole state: a regular run writes it instead of scraping, and the catch-up
// agent (LINKEDIN_CATCHUP=1, every 15 min) scrapes LinkedIn only while it
// exists and the Mac is fully awake, then removes it. Any LinkedIn attempt
// clears it, so a real failure is still left to health monitoring instead of
// being retried every 15 minutes.
const PENDING = join(__dir, "linkedin-pending");
const CATCHUP = process.env.LINKEDIN_CATCHUP === "1";
if (CATCHUP && !existsSync(PENDING)) process.exit(0);   // the common case: nothing deferred, not worth a log line
if (CATCHUP && darkWakeOnBattery()) {
  log("linkedin catch-up: still in a DarkWake on battery — LinkedIn stays pending");
  process.exit(0);
}

const PROFILE = join(__dir, ".browser-profile");
const APPS = join(__dir, "applications");
// Fresh clone has no applications/ yet; readPackages/writeTextAtomic below need it.
mkdirSync(APPS, { recursive: true, mode: 0o700 });   // packages quote recruiter/job text — owner-only (mode applies at creation; existing dirs keep theirs)
const SEEN_FILE = join(__dir, "jobs-seen.json");
const HEALTH_FILE = join(__dir, "source-health.json");
const DOU_ONLY = process.env.DOU_ONLY === "1";

// Hand-edited like skills.json, and parsed just as early: one trailing comma
// killed both launchd agents at import with a raw SyntaxError that never named
// the file, before the run lock or a banner — noticed only by reading logs/.
// Nothing sensible runs without it, so the run stops, but says why. The banner
// is the 3-hourly run's alone: the catch-up agent would repeat it every 15 min.
// Flags, lists, numeric knobs and misspelt keys are all handled in
// lib/jobs-config.mjs, once, so every section below sees normalized values.
let rawConfig;
try {
  rawConfig = readJobsConfig(join(__dir, "jobs.config.json"));
} catch (e) {
  log(`⚠ jobs.config.json unusable (${e.message}) — fix the JSON; nothing was scanned`);
  if (!CATCHUP) banner("Job assistant", "jobs.config.json is broken — fix the JSON (details in logs/)");
  process.exit(1);
}
const {
  config, minScore: MIN_SCORE, sourceMinScore: SOURCE_MIN_SCORE,
  llmMinScore: LLM_MIN_SCORE, llmMaxPerRun: LLM_MAX_PER_RUN, llmConcurrency: LLM_CONCURRENCY,
  candidateCountry: CANDIDATE_COUNTRY, countryOnly: COUNTRY_ONLY,
} = normalizeJobsConfig(rawConfig, { log });
const LLM = config.llm || {};

// A run that was due to scrape LinkedIn but could not (the run lock or the
// browser profile was busy) leaves the catch-up marker behind, so the 15-minute
// catch-up agent retries it instead of LinkedIn waiting 3 hours for the next slot.
const LINKEDIN_DUE = !DOU_ONLY && Boolean(config.linkedin?.enabled);
function markLinkedInPending(why) {
  if (!LINKEDIN_DUE) return;
  try { writeFileSync(PENDING, `${new Date().toISOString()}\n`); log(`linkedin: ${why} — left pending for the catch-up agent`); }
  catch (e) { log("linkedin: pending marker not written:", e.message); }
}

// Run-wide lock (jobs-run.lock/): two overlapping runs (launchd + manual) would
// both read jobs-seen.json, both write packages for the same vacancy, and the
// last save would drop the other's entries. Second run exits quietly — 0 so
// launchd does not flag it as a failure. Released on process exit.
try {
  acquireProfileLock(join(__dir, "jobs-run"));
} catch (e) {
  if (!/profile busy/.test(e.message)) throw e;
  log("another jobs.mjs run is active — exiting");
  markLinkedInPending("another run holds the lock");
  process.exit(0);
}

// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
const RESUME_TXT = existsSync(join(__dir, "resume.txt")) ? readFileSync(join(__dir, "resume.txt"), "utf8") : "";
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;
if (LLM.enabled && !RESUME_TXT) log("llm: enabled in config but resume.txt is missing — LLM re-scoring off this run");

const notify = (msg, opts) =>
  banner("Job assistant", (msg || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Jobs ready", opts);

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
const skippedSources = [];   // left out of this run on purpose — not "absent" to health monitoring

// Seniority terms we never apply to, matched as whole words in the TITLE only
// (see lib/keyword-gate.mjs). Same normalization as the two lists in
// lib/filters.mjs: a hand-edited excludeTitle that is not an array used to
// throw here, before a single job was gathered.
const excludedByTitle = titleExcluder(excludeList(config.excludeTitle));

// Known before it is opened: already in the seen store (either key spelling) or
// excluded by title. LinkedIn skips the click + 1.8 s and Djinni the detail-page
// fetch for such jobs (most of every run); the scoring loop still re-stamps
// the seen entry because the job is returned from its list fields.
const knownJob = (job) => seenEither(seen, identityKey(job)) || Boolean(excludedByTitle(job.title));

// 1–2) Browserless sources: DOU (RSS, always on), Djinni (public jobs board),
// Himalayas (public JSON API, remote jobs open to candidateCountry), Telegram
// channels (public web preview of job channels).
// Same gather/record/collect shape.
// One contract for every source: fetch(sectionConfig, log, { skip, countries, doFetch }).
// A source ignores what it does not need (DOU reads full RSS items, so none of
// it); adding a board is one row here plus one module in lib/sources/.
const SOURCE_OPTS = { skip: knownJob, countries: CANDIDATE_COUNTRY };
const BROWSERLESS_SOURCES = [
  { name: "dou", enabled: config.dou?.enabled !== false, fetch: fetchDou }, // on unless explicitly disabled
  { name: "djinni", enabled: config.djinni?.enabled, fetch: fetchDjinni },
  { name: "himalayas", enabled: config.himalayas?.enabled, fetch: fetchHimalayas },
  { name: "tgchannels", enabled: config.tgchannels?.enabled, fetch: fetchTgChannels },
];
for (const s of BROWSERLESS_SOURCES) {
  // Say it out loud: a source turned off by a typo looked exactly like a source
  // that simply found nothing, and it never reached summary.sources so health
  // monitoring could not flag it either.
  // An explicit `enabled: false` is the owner's choice, not an outage: left out
  // of health monitoring. A missing or misspelt section still is not, so the
  // "absent" alert keeps catching the typo.
  if (!s.enabled) {
    log(`${s.name}: disabled in config — skipped`);
    if (config[s.name]?.enabled === false) skippedSources.push(s.name);
    continue;
  }
  if (CATCHUP) { skippedSources.push(s.name); continue; }   // they ran in the deferring run; the catch-up is for LinkedIn
  log(`Gathering ${s.name}...`);
  sourcesTried++;
  try {
    const found = await s.fetch(config[s.name], log, SOURCE_OPTS);
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
const LINKEDIN_ON = LINKEDIN_DUE;
if (CATCHUP && !LINKEDIN_ON) rmSync(PENDING, { force: true });   // turned off since it was deferred: nothing to catch up
// The feed needs more than a DarkWake's 5–10 s, so a run here only ever timed
// out and reported LinkedIn as 0 found. Defer it and leave it out of health
// monitoring: it was not tried, so it did not break.
const LINKEDIN_DEFERRED = LINKEDIN_ON && darkWakeOnBattery();
if (DOU_ONLY) { log("linkedin: skipped (DOU_ONLY=1)"); skippedSources.push("linkedin"); }
else if (!config.linkedin?.enabled) {
  log("linkedin: disabled in config — skipped");
  if (config.linkedin?.enabled === false) skippedSources.push("linkedin");   // see the browserless loop above
}
else if (LINKEDIN_DEFERRED) {
  log("linkedin: deferred — the Mac is in a DarkWake on battery; the catch-up agent runs it after the next full wake");
  skippedSources.push("linkedin");
  try { writeFileSync(PENDING, `${new Date().toISOString()}\n`); } catch (e) { log("linkedin: pending marker not written:", e.message); }
}
if (LINKEDIN_ON && !LINKEDIN_DEFERRED) {
  let ctx, busy = false;
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
    if (/profile busy/.test(e.message)) { busy = true; sourcesTried--; skippedSources.push("linkedin"); }   // not an outage: the source was never tried
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
    await closeBounded(ctx, { log });   // bounded: a hung close held both locks forever
    // Busy = not tried: it stays (or becomes) pending for the next 15-minute tick.
    if (busy) markLinkedInPending("browser profile busy");
    else rmSync(PENDING, { force: true });
  }
}

log(`Total jobs gathered: ${jobs.length}`);

// Drop vacancies physically located abroad — applies to every source (DOU
// marks them "за кордоном", Djinni "Тільки офіс · Польща", etc).
{
  const before = jobs.length;
  const keptLoc = filterByLocation(jobs, config.excludeLocation, CANDIDATE_COUNTRY, { countryOnly: COUNTRY_ONLY });
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
const packageLinks = new Map();
for (const fm of readPackages(APPS, { warn: (f, e) => log(`  · unreadable package skipped: ${f} (${e?.message})`) })) {
  // "—" is the blank-company placeholder; canonicalKey scopes those by url,
  // so pass the url along instead of filtering on a truthy company.
  // The url is carried too: "same source = a distinct req" is only true when
  // the URL differs. After a seen-store quarantine every live vacancy looks new
  // again, and without the url check each one got re-scored (a paid LLM call)
  // and written a SECOND time — the filename embeds a fresh minute stamp, so it
  // could never collide and the duplicate was invisible.
  // A list per key: two same-source reqs can share one, and keeping only the
  // last one read lost the other's url — the same-url guard below then missed it.
  if (!fm.title) continue;
  const key = canonicalKey({ company: fm.company, title: fm.title, url: fm.url });
  if (!packageIndex.has(key)) packageIndex.set(key, []);
  packageIndex.get(key).push({ file: fm.file, source: fm.source || "", url: fm.url || "" });
  // By link too: a channel's repost of this vacancy carries a title of its own.
  const link = linkKey(fm.url);
  if (link && !packageLinks.has(link)) packageLinks.set(link, fm.file);
}

// 5a) Score all unseen jobs locally (cheap) and collect the gate-passers.
// Keyword gate: per-source/global minScore + requireRole. Passers go to 5b,
// where the LLM applies a second gate (llm.minScore).
let considered = 0;
const matches = [];
// Stamp a job seen together with the copies dedupeJobs folded into it.
const stamp = (job, id) => { seen.add(id); for (const m of job.mergedIds || []) seen.add(m); };
// A job turned down on its title alone (no description yet) stays unseen so
// the next run re-reads it — once. The second title-only "no" stamps it seen:
// a description that never loads (a short posting, selector drift) used to be
// re-scraped, and re-judged by the paid LLM, every run forever. `gate` keeps
// the keyword and LLM markers apart; neither key reads as seen.
function titleOnlyNo(job, id, gate) {
  const key = `title-only-${gate}:${id}`;
  if (!seen.has(key)) { seen.add(key); return; }
  stamp(job, id);
}
for (const job of jobs) {
  const g = keywordGate(job, {
    seen, packageIndex, packageLinks, excludedByTitle,
    minScore: SOURCE_MIN_SCORE[job.source] ?? MIN_SCORE,
    requireRole: config.requireRole,
  });
  const { id } = g;
  if (g.considered) considered++;
  switch (g.kind) {
    case "seen": break;   // re-stamped below: the TTL is "last seen", so a vacancy still live after 90 days never resurfaces
    case "packaged": log(`  · already packaged (${g.file}) ${job.source}: ${job.title}`); break;
    case "dup":
      try { appendAltLink(join(APPS, g.file), job.source, job.url); }
      catch (e) { log(`  · alt-link append failed (${g.file}): ${e.message}`); }
      log(`  · dup-of-existing (${g.file}) ${job.source}: ${job.title}`);
      break;
    case "excluded": log(`  · skip [excluded:${g.term}] ${job.source}: ${job.title}`); break;
    case "low":
      log(`  · skip [${g.scored.score}${g.scored.matchedRole ? "" : " no-role"}] ${job.source}: ${job.title}${g.retry ? " (no description — will retry)" : ""}`);
      break;
    case "match": matches.push({ id, job, scored: g.scored, retry: g.retry }); continue;
  }
  recordOutcome(summary, job.source, { seen: "seen", packaged: "seen", dup: "seen", excluded: "excluded", low: "low" }[g.kind]);
  if (g.retry) titleOnlyNo(job, id, "kw");   // a "low" with no description: re-read once with it
  else stamp(job, id);
}

// 5b) Strongest keyword matches first: LLM re-score + tailored letter (capped
// per run), then the package write — lib/llm-gate.mjs.
const { written, writtenList, llmFailed, llmDropped, llmDeferred, llmFallback } = await judgeMatches(matches, {
  llm: { on: llmOn, minScore: LLM_MIN_SCORE, maxPerRun: LLM_MAX_PER_RUN, concurrency: LLM_CONCURRENCY, model: LLM.model || "sonnet", resume: RESUME_TXT, country: CANDIDATE_COUNTRY[0] },
  seen, stamp, titleOnlyNo, summary, appsDir: APPS, log,
});

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
const degraded = detectDegradations(health, summary, { skipped: skippedSources });
if (degraded.length) alerts.push(formatAlert(degraded));
if (llmFailed > 2) {
  const fate = [llmDeferred && `${llmDeferred} deferred to the next run`, llmFallback && `${llmFallback} keyword-only`].filter(Boolean).join(", ");
  alerts.push(`⚠️ LLM failed ${llmFailed}× — ${fate}`);
}
// Never write back a baseline we could not read: that is the silent reset.
// Guarded like the package write: an ENOSPC/EACCES here used to take down the
// dashboard refresh, the banner and the exit code below with it.
if (healthReadable) {
  try { writeJsonAtomic(HEALTH_FILE, appendHistory(health, currentCounts(summary))); }
  catch (e) { log(`⚠ ${HEALTH_FILE} not written (${e.message}) — this run is missing from the health baseline`); }
}

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore", timeout: 60_000 });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

// One banner per run: breakage alerts + the new packages. Silent when neither.
// Telegram already has every package as its own message, so it gets only the alerts.
const bannerText = formatRunBanner(writtenList, alerts);
if (bannerText) notify(bannerText, { toTelegram: false });
if (alerts.length) queueTelegram(alertMessage("Job assistant", alerts.join("\n")));
// launchd must see a failed run as failed (the convention djinni-check.mjs:144
// already follows). "Failed" is only "every source we tried threw" — a quiet
// run that gathered nothing because there was nothing new stays 0.
const runFailed = sourcesTried > 0 && sourcesFailed === sourcesTried;
if (runFailed) log(`All ${sourcesTried} source(s) failed — exiting 1 so the scheduler sees it`);
process.exit(runFailed ? 1 : 0);
