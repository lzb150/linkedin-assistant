// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board),
// Jooble (API), and LinkedIn (scrape), scores them against your resume, and
// writes an application package for each RELEVANT match. IT NEVER SUBMITS
// ANYTHING — you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU + Djinni + Jooble still run)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage } from "./lib/relevance.mjs";
import { buildApplication } from "./lib/application.mjs";
import { llmJSON, buildJobPrompt } from "./lib/llm.mjs";
import { detectLang } from "./lib/lang.mjs";
import { dedupeJobs, identityKey } from "./lib/dedup.mjs";
import {
  newSummary, recordFound, recordOutcome, recordMerged, recordTop,
  formatTable, formatNotification,
} from "./lib/run-summary.mjs";
import { fetchDou } from "./lib/sources/dou.mjs";
import { fetchDjinni } from "./lib/sources/djinni.mjs";
import { fetchJooble } from "./lib/sources/jooble.mjs";
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";
import { currentCounts, detectRegressions, mergeCounts, formatAlert } from "./lib/source-health.mjs";
import { log, notify as osaNotify } from "./lib/notify.mjs";
import { launchBrowser } from "./lib/browser.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const APPS = join(__dir, "applications");
const SEEN_FILE = join(__dir, "jobs-seen.json");
const HEALTH_FILE = join(__dir, "source-health.json");
const NOTIFIER_APP = join(__dir, "Notifier.app"); // built by build-notifier.sh
const DOU_ONLY = process.env.DOU_ONLY === "1";

const config = JSON.parse(readFileSync(join(__dir, "jobs.config.json"), "utf8"));

// Resume text grounds the LLM prompts. Missing file → LLM disabled this run.
function loadResume() {
  try { return readFileSync(join(__dir, "resume.txt"), "utf8"); } catch { return ""; }
}
const RESUME_TXT = loadResume();
const LLM = config.llm || {};
const llmOn = Boolean(LLM.enabled) && RESUME_TXT.length > 0;

// Prefer Notifier.app (the green Messages icon, same banner as check.mjs) and
// fall back to osascript (shows the Script Editor icon) if the app is missing.
// Notifier.app MUST be launched via `open` so macOS treats it as a registered
// app, detached + unref'd so the banner survives this process exiting.
const notifyOsascript = (msg) => osaNotify("Job assistant", msg);
function notify(msg) {
  const body = (msg || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Jobs ready";
  if (existsSync(NOTIFIER_APP)) {
    try {
      const p = spawn("open", ["-n", "-a", NOTIFIER_APP, "--args", "Job assistant", body],
        { detached: true, stdio: "ignore" });
      p.on("error", (e) => { log("notify: Notifier.app failed, osascript fallback:", e?.message); notifyOsascript(body); });
      p.unref();
      log("notify: via Notifier.app (green Messages icon)");
      return;
    } catch (e) { log("notify: spawn threw, osascript fallback:", e?.message); }
  } else {
    log("notify: Notifier.app missing at", NOTIFIER_APP, "— osascript fallback");
  }
  notifyOsascript(body);
}

// jobs-seen.json now stores identity keys (normalize(company)+title), not URLs,
// so a vacancy is "seen" regardless of which source it came from. Older files
// hold URLs — detect that legacy format and start fresh (history is rebuilt
// from the jobs processed in this run).
function loadSeen() {
  try {
    const entries = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    if (entries.some((e) => typeof e === "string" && e.startsWith("http"))) {
      log("jobs-seen.json is in the legacy URL format — migrating to identity keys (starting fresh)");
      return new Set();
    }
    return new Set(entries);
  } catch { return new Set(); }
}
const seen = loadSeen();

// source-health.json records each source's `found` count from the last run so we
// can warn when a source that had results suddenly returns zero (a likely sign
// its scraper broke). Missing/unparseable file → no history (no alerts, just seed).
function loadHealth() {
  try { return JSON.parse(readFileSync(HEALTH_FILE, "utf8")); }
  catch { return {}; }
}
const prevHealth = loadHealth();

let jobs = [];
const summary = newSummary();

// 1–3) Browserless sources: DOU (RSS, always on), Djinni (public jobs board),
// Jooble (official API — needs JOOBLE_API_KEY). Same gather/record/collect shape.
const BROWSERLESS_SOURCES = [
  { name: "dou", enabled: true, fetch: fetchDou },
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
  } catch (e) { log(`${s.name} error:`, e.message); }
}

// 4) LinkedIn via the logged-in browser (optional)
if (!DOU_ONLY && config.linkedin?.enabled) {
  const ctx = await launchBrowser(PROFILE);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    // bail early if logged out
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
      log("⚠️  LinkedIn session expired — skipping LinkedIn jobs. Run: node login.mjs");
    } else {
      log("Gathering LinkedIn jobs (scraping, modest)...");
      const liJobs = await fetchLinkedInJobs(page, config.linkedin, log);
      recordFound(summary, "linkedin", liJobs.length);
      jobs.push(...liJobs);
    }
  } catch (e) {
    log("LinkedIn error:", e.message);
  } finally {
    await ctx.close();
  }
}

log(`Total jobs gathered: ${jobs.length}`);

// Collapse the same vacancy arriving from multiple sources into one record
// (keeps the longest description, records the other source links in altLinks).
const { deduped, mergedCount } = dedupeJobs(jobs);
jobs = deduped;
recordMerged(summary, mergedCount);
log(`Deduped: merged ${mergedCount} cross-source duplicate(s) → ${jobs.length} unique`);

// Seniority terms we never apply to. Matched as whole words in the TITLE only,
// so a senior role whose description mentions "junior" (e.g. "mentor junior
// engineers") is kept, while "Junior AQA"/"QA Intern"/"Trainee QA" are dropped.
const EXCLUDE_TITLE = (config.excludeTitle || []).map((t) => t.toLowerCase());
function excludedByTitle(title) {
  const t = (title || "").toLowerCase();
  return EXCLUDE_TITLE.find((term) =>
    new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t)
  );
}

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

writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 0));
log(`Done. Considered ${considered} new, wrote ${written} application package(s) to ${APPS}`);

// Per-source digest of this run (scraper health + the day's catch).
log("\n" + formatTable(summary));

// Scraper-health: warn (separate banner) if a source that had results on the
// previous run returned 0 this run, then persist this run's counts for next time.
const regressions = detectRegressions(prevHealth, summary);
if (regressions.length) notify(formatAlert(regressions));
writeFileSync(HEALTH_FILE, JSON.stringify(mergeCounts(prevHealth, currentCounts(summary)), null, 0));

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
