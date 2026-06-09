// Job discovery + matching. Finds vacancies on DOU (RSS), Djinni (jobs board),
// and LinkedIn (scrape), scores them against your resume, and writes an
// application package for each RELEVANT match. IT NEVER SUBMITS ANYTHING —
// you review and apply manually.
//
// Run:  node jobs.mjs              (all sources per jobs.config.json)
//       HEADFUL=1 node jobs.mjs    (watch the LinkedIn part)
//       DOU_ONLY=1 node jobs.mjs   (skip LinkedIn scraping; DOU + Djinni still run)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreMessage } from "./lib/relevance.mjs";
import { buildApplication } from "./lib/application.mjs";
import { fetchDou } from "./lib/sources/dou.mjs";
import { fetchDjinni } from "./lib/sources/djinni.mjs";
import { fetchLinkedInJobs } from "./lib/sources/linkedin-jobs.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const APPS = join(__dir, "applications");
const SEEN_FILE = join(__dir, "jobs-seen.json");
const NOTIFIER_APP = join(__dir, "Notifier.app"); // built by build-notifier.sh
const HEADFUL = process.env.HEADFUL === "1";
const DOU_ONLY = process.env.DOU_ONLY === "1";

const config = JSON.parse(readFileSync(join(__dir, "jobs.config.json"), "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Prefer Notifier.app (the green Messages icon, same banner as check.mjs) and
// fall back to osascript (shows the Script Editor icon) if the app is missing.
// Notifier.app MUST be launched via `open` so macOS treats it as a registered
// app, detached + unref'd so the banner survives this process exiting.
const notifyOsascript = (msg) =>
  execFile("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "Job assistant"`], () => {});
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

function loadSeen() { try { return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); } }
const seen = loadSeen();

let jobs = [];

// 1) DOU via RSS (no browser needed)
log("Gathering DOU (RSS)...");
try { jobs.push(...(await fetchDou(config.dou, log))); } catch (e) { log("DOU error:", e.message); }

// 2) Djinni via the public jobs board (plain fetch, no browser, no login)
if (config.djinni?.enabled) {
  log("Gathering Djinni (jobs board)...");
  try { jobs.push(...(await fetchDjinni(config.djinni, log))); } catch (e) { log("Djinni error:", e.message); }
}

// 3) LinkedIn via the logged-in browser (optional)
if (!DOU_ONLY && config.linkedin?.enabled) {
  const { chromium } = await import("playwright");
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !HEADFUL,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    // bail early if logged out
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
      log("⚠️  LinkedIn session expired — skipping LinkedIn jobs. Run: node login.mjs");
    } else {
      log("Gathering LinkedIn jobs (scraping, modest)...");
      jobs.push(...(await fetchLinkedInJobs(page, config.linkedin, log)));
    }
  } catch (e) {
    log("LinkedIn error:", e.message);
  } finally {
    await ctx.close();
  }
}

log(`Total jobs gathered: ${jobs.length}`);

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

// 4) Score + write application packages for RELEVANT, unseen jobs.
let written = 0, considered = 0;
for (const job of jobs) {
  if (seen.has(job.url)) continue;
  considered++;
  const excluded = excludedByTitle(job.title);
  if (excluded) {
    log(`  · skip [excluded:${excluded}] ${job.source}: ${job.title}`);
    seen.add(job.url);
    continue;
  }
  const scored = scoreMessage(job.text);
  // Cold applications: strict gate — high score AND an automation/SDET role match.
  const minScore = config.minScore ?? 25;
  const needRole = config.requireRole ? Boolean(scored.matchedRole) : true;
  if (scored.score < minScore || !needRole) {
    log(`  · skip [${scored.score}${scored.matchedRole ? "" : " no-role"}] ${job.source}: ${job.title}`);
    seen.add(job.url);
    continue;
  }
  const { filename, markdown } = buildApplication(job, scored);
  writeFileSync(join(APPS, filename), markdown);
  log(`  ✓ MATCH [${scored.score}] ${job.source}: ${job.title} @ ${job.company}`);
  seen.add(job.url);
  written++;
}

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
