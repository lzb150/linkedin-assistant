// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board),
// Jooble (API), and LinkedIn (scrape), scores them against your resume, and
// writes an application package for each RELEVANT match. IT NEVER SUBMITS
// ANYTHING — you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU + Djinni + Jooble still run)

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage } from "./lib/relevance.mjs";
import { buildApplication, appendAltLink } from "./lib/application.mjs";
import { llmJSON, buildJobPrompt, numericScore } from "./lib/llm.mjs";
import { detectLang } from "./lib/lang.mjs";
import { dedupeJobs, identityKey, canonicalKey } from "./lib/dedup.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { filterByLocation } from "./lib/filters.mjs";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatNotification, topMatches, formatTopMatches,
} from "./lib/run-summary.mjs";
import { fetchDou } from "./lib/sources/dou.mjs";
import { fetchDjinni } from "./lib/sources/djinni.mjs";
import { fetchJooble } from "./lib/sources/jooble.mjs";
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";
import { fetchWorkua, pageHtml } from "./lib/sources/workua.mjs";
import { fetchRobota } from "./lib/sources/robota.mjs";
import { fetchGlassdoor } from "./lib/sources/glassdoor.mjs";
import { currentCounts, normalizeHistory, detectDegradations, appendHistory, formatAlert } from "./lib/source-health.mjs";
import { log, notify as banner } from "./lib/notify.mjs";
import { launchBrowser, acquireProfileLock } from "./lib/browser.mjs";
import { loadSeenStore } from "./lib/seen-store.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";

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
// Fresh clone has no applications/ yet; readdirSync/writeFileSync below need it.
mkdirSync(APPS, { recursive: true });
const SEEN_FILE = join(__dir, "jobs-seen.json");
const HEALTH_FILE = join(__dir, "source-health.json");
const DOU_ONLY = process.env.DOU_ONLY === "1";

const config = JSON.parse(readFileSync(join(__dir, "jobs.config.json"), "utf8"));

// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
function loadResume() {
  try { return readFileSync(join(__dir, "resume.txt"), "utf8"); } catch { return ""; }
}
const RESUME_TXT = loadResume();
const LLM = config.llm || {};
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;
if (LLM.enabled && !RESUME_TXT) log("llm: enabled in config but resume.txt is missing — LLM re-scoring off this run");

const notify = (msg) =>
  banner("Job assistant", (msg || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Jobs ready");

// jobs-seen.json stores identity keys (normalize(company)+title) with a
// last-seen timestamp (90-day TTL), so a vacancy is "seen" regardless of
// source and the file stops growing forever. Legacy array files migrate on
// load; the oldest URL-keyed format starts fresh.
const seen = loadSeenStore(SEEN_FILE, {
  isLegacy: (arr) => {
    const stale = arr.some((e) => typeof e === "string" && e.startsWith("http"));
    if (stale) log("jobs-seen.json is in the legacy URL format — migrating to identity keys (starting fresh)");
    return stale;
  },
});
const saveSeen = () => seen.save();

// source-health.json keeps the last 10 runs' `found` counts per source so we
// can warn when a source degrades well below its recent norm (a likely sign
// its scraper broke). Missing/unparseable/legacy file → normalized quietly.
function loadHealth() {
  try { return JSON.parse(readFileSync(HEALTH_FILE, "utf8")); }
  catch { return {}; }
}
const health = normalizeHistory(loadHealth());

let jobs = [];
const summary = newSummary();

// 1–3) Browserless sources: DOU (RSS, always on), Djinni (public jobs board),
// Jooble (official API — needs JOOBLE_API_KEY). Same gather/record/collect shape.
const BROWSERLESS_SOURCES = [
  { name: "dou", enabled: config.dou?.enabled !== false, fetch: fetchDou }, // on unless explicitly disabled
  { name: "djinni", enabled: config.djinni?.enabled, fetch: fetchDjinni },
  { name: "jooble", enabled: config.jooble?.enabled, fetch: fetchJooble },
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

// 4–6) Browser sources: LinkedIn (needs login), Robota.ua and Work.ua (both
// Cloudflare-gated, no login) share one Playwright context. Each source has its own try/catch so
// one failing does not skip the other or hide from health monitoring.
const BROWSER_SOURCES = ["linkedin", "robota", "workua", "glassdoor"];
if (!DOU_ONLY && BROWSER_SOURCES.some((s) => config[s]?.enabled)) {
  let ctx;
  try {
    ctx = await launchBrowser(PROFILE); // inside try: a launch/lock failure logs + notifies instead of an unhandled rejection
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (config.linkedin?.enabled) {
      try {
        // bail early if logged out
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
        if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
          log("⚠️  LinkedIn session expired — skipping LinkedIn jobs. Run: node login.mjs");
          recordFound(summary, "linkedin", 0); // expired session is a hard failure for health monitoring
        } else {
          log("Gathering LinkedIn jobs (scraping, modest)...");
          const liJobs = await fetchLinkedInJobs(page, config.linkedin, log);
          recordFound(summary, "linkedin", liJobs.length);
          jobs.push(...liJobs);
        }
      } catch (e) { log("LinkedIn error:", e.message); recordFound(summary, "linkedin", 0); }
    }
    if (config.robota?.enabled) {
      log("Gathering Robota.ua...");
      try {
        const rJobs = await fetchRobota(page, config.robota, log);
        recordFound(summary, "robota", rJobs.length);
        jobs.push(...rJobs);
      } catch (e) { log("Robota.ua error:", e.message); recordFound(summary, "robota", 0); }
    }
    if (config.workua?.enabled) {
      log("Gathering Work.ua (browser)...");
      try {
        const wJobs = await fetchWorkua(config.workua, log, pageHtml(page));
        recordFound(summary, "workua", wJobs.length);
        jobs.push(...wJobs);
      } catch (e) { log("Work.ua error:", e.message); recordFound(summary, "workua", 0); }
    }
    if (config.glassdoor?.enabled) {
      log("Gathering Glassdoor...");
      try {
        const gJobs = await fetchGlassdoor(page, config.glassdoor, log);
        recordFound(summary, "glassdoor", gJobs.length);
        jobs.push(...gJobs);
      } catch (e) { log("Glassdoor error:", e.message); recordFound(summary, "glassdoor", 0); }
    }
  } catch (e) {
    log("Browser sources error:", e.message);
    // "profile busy" = benign overlap with check.mjs/login.mjs: no banner, and
    // no 0-counts either — leaving the sources out of the summary keeps a
    // skipped run from looking like a scraper outage to health monitoring.
    if (!/profile busy/.test(e.message)) {
      if (!ctx) notify(`Browser launch failed: ${e.message}`);
      // Launch/lock failure happens before the per-source catches: record 0 for
      // every enabled browser source so health monitoring sees the outage.
      for (const s of BROWSER_SOURCES) {
        if (config[s]?.enabled && !summary.sources[s]) recordFound(summary, s, 0);
      }
    }
  } finally {
    await ctx?.close();
  }
}

log(`Total jobs gathered: ${jobs.length}`);

// Drop vacancies physically located abroad — applies to every source (DOU
// marks them "за кордоном", Jooble UA carries "Краків, Польща", etc).
{
  const before = jobs.length;
  jobs = filterByLocation(jobs, config.excludeLocation);
  if (jobs.length < before) log(`Location filter: dropped ${before - jobs.length} foreign-location job(s)`);
}

// Collapse the same vacancy arriving from multiple sources into one record
// (keeps the longest description, records the other source links in altLinks).
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
recordMerged(summary, mergedCount);
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);

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

// Canonical-key index of existing packages (cross-run dedup): the same vacancy
// resurfacing on ANOTHER board must not spawn a second package — its link is
// appended to the existing one instead. Same source = a distinct req, allowed.
const packageIndex = new Map();
{
  for (const f of readdirSync(APPS)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = parseFrontmatter(readFileSync(join(APPS, f), "utf8"));
      // "—" is the blank-company placeholder; canonicalKey scopes those by url,
      // so pass the url along instead of filtering on a truthy company.
      if (fm?.title) packageIndex.set(canonicalKey({ company: fm.company, title: fm.title, url: fm.url }), { file: f, source: fm.source || "" });
    } catch { log(`  · unreadable package skipped: ${f}`); }
  }
}

// 5a) Score all unseen jobs locally (cheap) and collect the gate-passers.
// Gate unchanged: per-source/global minScore + requireRole. LLM never gates.
let written = 0, considered = 0;
const matches = [];
for (const job of jobs) {
  const id = identityKey(job);
  // ponytail: keys stamped before 2026-08-28 had + and # stripped ("c++" → "c");
  // accept that spelling too until they age out of the 90-day TTL (~2026-11-28).
  const legacyId = id.replace(/[+#]+/g, " ").replace(/\s+/g, " ").trim();
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
  matches.push({ id, job, scored });
}

// 5b) Strongest keyword matches first: LLM re-score + tailored letter (capped
// per run), then write the package. LLM failure → keyword-only package.
matches.sort((a, b) => b.scored.score - a.scored.score);
const writtenList = [];
let llmCalls = 0;
for (const { id, job, scored } of matches) {
  const label = `${job.title} @ ${job.company}`;
  let llm = null;
  if (llmOn && llmCalls < (LLM.maxPerRun ?? 15)) {
    llmCalls++;
    const res = await llmJSON(buildJobPrompt(RESUME_TXT, job, detectLang(job.text)), { model: LLM.model || "haiku" });
    // Normalize the score once at the trust boundary; downstream (log,
    // package frontmatter, writtenList) can rely on a rounded number.
    const n = res ? numericScore(res.score) : null;
    if (n !== null) llm = { ...res, score: Math.min(100, Math.max(0, Math.round(n))) };
    else log(`  · llm failed for: ${job.title} — keyword-only package`);
  }
  const { filename, markdown } = buildApplication(job, scored, llm);
  writeFileSync(join(APPS, filename), markdown);
  log(`  ✓ MATCH [${scored.score}${llm ? ` / llm ${llm.score}` : ""}] ${job.source}: ${label}`);
  recordOutcome(summary, job.source, "written");
  recordTop(summary, scored.score, label);
  writtenList.push({ score: scored.score, llmScore: llm ? llm.score : null, label });
  seen.add(id);
  // Persist after every package: a crash mid-run must not forget written
  // packages (the next run would re-score and re-pay the LLM for them).
  saveSeen();
  written++;
}

saveSeen();
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));

// Scraper-health: warn (separate banner) if a source came in far below its
// recent norm, then append this run's counts to the history.
const degraded = detectDegradations(health, summary);
if (degraded.length) notify(formatAlert(degraded));
writeJsonAtomic(HEALTH_FILE, appendHistory(health, currentCounts(summary)));

// Refresh the HTML dashboard so applications/index.html always reflects current packages.
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(__dir, "dashboard.mjs")], { stdio: "ignore", timeout: 60_000 });
} catch (e) {
  log("dashboard refresh skipped:", e.message);
}

// Separate banner for strong matches so they don't drown in the run digest.
const top = topMatches(writtenList);
if (top.length) notify(formatTopMatches(top));

// Always notify with the run outcome (previously only fired when written > 0).
notify(formatNotification(summary));
process.exit(0);
