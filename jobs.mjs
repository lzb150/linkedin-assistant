// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board)
// and LinkedIn (scrape), scores them against your resume, and
// writes an application package for each RELEVANT match. IT NEVER SUBMITS
// ANYTHING — you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU + Djinni still run)

import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage } from "./lib/relevance.mjs";
import { buildApplication, appendAltLink } from "./lib/application.mjs";
import { llmJSON, buildJobPrompt, numericScore, llmRejects } from "./lib/llm.mjs";
import { detectLang } from "./lib/lang.mjs";
import { dedupeJobs, identityKey, canonicalKey } from "./lib/dedup.mjs";
import { readPackages } from "./lib/packages.mjs";
import { filterByLocation } from "./lib/filters.mjs";
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
import { launchBrowser, acquireProfileLock } from "./lib/browser.mjs";
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
// Fresh clone has no applications/ yet; readdirSync/writeTextAtomic below need it.
mkdirSync(APPS, { recursive: true });
const SEEN_FILE = join(__dir, "jobs-seen.json");
const HEALTH_FILE = join(__dir, "source-health.json");
const DOU_ONLY = process.env.DOU_ONLY === "1";

const config = JSON.parse(readFileSync(join(__dir, "jobs.config.json"), "utf8"));

// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
const RESUME_TXT = existsSync(join(__dir, "resume.txt")) ? readFileSync(join(__dir, "resume.txt"), "utf8") : "";
const LLM = config.llm || {};
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;
if (LLM.enabled && !RESUME_TXT) log("llm: enabled in config but resume.txt is missing — LLM re-scoring off this run");

const notify = (msg) =>
  banner("Job assistant", (msg || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Jobs ready");

// jobs-seen.json stores identity keys (normalize(company)+title) with a
// last-seen timestamp (90-day TTL), so a vacancy is "seen" regardless of
// source and the file stops growing forever.
const seen = loadSeenStore(SEEN_FILE);

// source-health.json keeps the last 10 runs' `found` counts per source so we
// can warn when a source degrades well below its recent norm (a likely sign
// its scraper broke). Missing/unparseable/legacy file → normalized quietly.
const health = normalizeHistory(readJson(HEALTH_FILE, {}));

let jobs = [];
const summary = newSummary();

// Seniority terms we never apply to. Matched as whole words in the TITLE only,
// so a senior role whose description mentions "junior" (e.g. "mentor junior
// engineers") is kept, while "Junior AQA"/"QA Intern"/"Trainee QA" are dropped.
// Regexes compiled once at load, not per job.
const EXCLUDE_TITLE = (config.excludeTitle || []).map((t) => ({
  term: t.toLowerCase(),
  re: new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i"),
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
  if (!s.enabled) continue;
  log(`Gathering ${s.name}...`);
  try {
    const found = await s.fetch(config[s.name], log);
    recordFound(summary, s.name, found.length);
    jobs.push(...found);
  } catch (e) {
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
  if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
    log("⚠️  LinkedIn session expired — skipping LinkedIn jobs. Run: node login.mjs");
    alerts.push("⚠️ LinkedIn session expired — run: node login.mjs");
    return [];
  }
  log("Gathering LinkedIn jobs (scraping, modest)...");
  return fetchLinkedInJobs(page, cfg, log, { skip: knownJob });
}
if (!DOU_ONLY && config.linkedin?.enabled) {
  let ctx;
  try {
    ctx = await launchBrowser(PROFILE); // inside try: a launch/lock failure logs + notifies instead of an unhandled rejection
    const page = ctx.pages()[0] || (await ctx.newPage());
    // Own try/catch so a scrape failure is logged and counted as 0 for health monitoring.
    try {
      const found = await fetchLinkedInChecked(page, config.linkedin);
      recordFound(summary, "linkedin", found.length);
      jobs.push(...found);
    } catch (e) { log("LinkedIn error:", e.message); recordFound(summary, "linkedin", 0); }
  } catch (e) {
    log("Browser sources error:", e.message);
    // "profile busy" = benign overlap with check.mjs/login.mjs: no banner, and
    // no 0-count either — leaving the source out of the summary keeps a
    // skipped run from looking like a scraper outage to health monitoring.
    if (!/profile busy/.test(e.message)) {
      if (!ctx) notify(`Browser launch failed: ${e.message}`);
      // Launch/lock failure happens before the inner catch: record 0 so health monitoring sees the outage.
      if (!summary.sources.linkedin) recordFound(summary, "linkedin", 0);
    }
  } finally {
    await ctx?.close();
  }
}

log(`Total jobs gathered: ${jobs.length}`);

// Drop vacancies physically located abroad — applies to every source (DOU
// marks them "за кордоном", Djinni "Тільки офіс · Польща", etc).
{
  const before = jobs.length;
  const keptLoc = filterByLocation(jobs, config.excludeLocation, config.candidateCountry || undefined);
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
  if (fm.title) packageIndex.set(canonicalKey({ company: fm.company, title: fm.title, url: fm.url }), { file: fm.file, source: fm.source || "" });
}

// 5a) Score all unseen jobs locally (cheap) and collect the gate-passers.
// Keyword gate: per-source/global minScore + requireRole. Passers go to 5b,
// where the LLM applies a second gate (llm.minScore).
let written = 0, considered = 0, llmFailed = 0;
const matches = [];
for (const job of jobs) {
  const id = identityKey(job);
  const legacyId = legacyIdOf(id);
  // Re-stamp on every sighting so the TTL is "last seen", not "first seen" —
  // a vacancy still live after 90 days must not resurface as new.
  if (seen.has(id) || seen.has(legacyId)) { recordOutcome(summary, job.source, "seen"); seen.add(id); continue; }
  const existing = packageIndex.get(canonicalKey(job));
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
  // A source may set its own minScore — it overrides the global.
  const minScore = config[job.source]?.minScore ?? config.minScore ?? 25;
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
const toScore = llmOn ? matches.slice(0, Math.max(1, Number(LLM.maxPerRun) || 15)) : matches;   // "0"/"abc" must not mean "defer everything forever"
for (const { job, scored } of (llmOn ? matches.slice(toScore.length) : [])) {
  log(`  · deferred [${scored.score}] ${job.source}: ${label(job)} — llm.maxPerRun reached, next run`);
}
// Score a few CLI calls at a time (~20 s each on sonnet, ~55 s on haiku; 15 in
// sequence used to take 14 min) while the loop below consumes verdicts in score
// order and writes each package as soon as its verdict is in — so a crash or a
// sleeping Mac mid-scoring keeps every package already paid for, exactly like
// the old sequential loop. A bad `concurrency` (0, "abc") must not mean zero
// workers, which would leave every verdict empty and bypass the LLM gate.
const verdict = new Map();   // m → Promise<llm result | null>
let scoring = Promise.resolve();
if (llmOn) {
  const resolvers = new Map(toScore.map((m) => { let res; verdict.set(m, new Promise((r) => { res = r; })); return [m, res]; }));
  scoring = pool(toScore, Math.max(1, Number(LLM.concurrency) || 3), async (m) => {
    resolvers.get(m)(await llmJSON(buildJobPrompt(RESUME_TXT, m.job, detectLang(m.job.text), { country: config.candidateCountry?.[0] }), { model: LLM.model || "sonnet", log }));
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
    if (n !== null) llm = { ...res, score: Math.min(100, Math.max(0, Math.round(n))), model: LLM.model || "sonnet" };
    else { llmFailed++; log(`  · llm failed for: ${job.title} — keyword-only package`); }
  }
  if (llmRejects(llm, LLM.minScore)) {
    log(`  · skip [${scored.score} / llm ${llm.score}] ${job.source}: ${lbl}`);
    recordOutcome(summary, job.source, "low");
    seen.add(id);
    seen.save();
    continue;
  }
  const { filename, markdown } = buildApplication(job, scored, llm);
  writeTextAtomic(join(APPS, filename), markdown);   // a crash mid-write must not leave a frontmatter-less package
  log(`  ✓ MATCH [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${lbl}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, lbl);
  writtenList.push({ score: scored.score, llmScore: llm ? llm.score : null, label: lbl });
  seen.add(id);
  // Persist after every package: a crash mid-run must not forget written
  // packages (the next run would re-score and re-pay the LLM for them).
  seen.save();
  written++;
}
await scoring;   // every worker has finished (all verdicts were consumed above; this just joins the pool)

seen.save();
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));

// Scraper-health: alert if a source came in far below its recent norm, then
// append this run's counts to the history. An LLM failing more than twice in
// one run is a breakage too (a single flake is not).
const degraded = detectDegradations(health, summary);
if (degraded.length) alerts.push(formatAlert(degraded));
if (llmFailed > 2) alerts.push(`⚠️ LLM failed ${llmFailed}× — keyword-only packages`);
writeJsonAtomic(HEALTH_FILE, appendHistory(health, currentCounts(summary)));

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore", timeout: 60_000 });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

// One banner per run: breakage alerts + the new packages. Silent when neither.
const bannerText = formatRunBanner(writtenList, alerts);
if (bannerText) notify(bannerText);
process.exit(0);
