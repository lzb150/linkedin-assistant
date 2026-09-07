// closed-check.mjs
// Daily: probe New/Viewed DOU, Djinni and LinkedIn vacancies and mark the ones the board
// reports inactive as status "closed" in job-state.json, so they leave the
// dashboard's New view and never reach a follow-up. Plain GETs, one per second.
//   node closed-check.mjs             probe (up to 150 urls, each at most every 3 days)
//   CLOSED_MAX=50 CLOSED_RECHECK_DAYS=7 node closed-check.mjs
// Packages closed for 14+ days (CLOSED_ARCHIVE_DAYS) are moved to
// applications/archive/, which nothing reads — keeps the dashboard small.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStoreOrExit, writeStore, mergeEntry } from "./lib/job-state.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";
import { notify, log } from "./lib/notify.mjs";
import { isClosed, selectCandidates, planArchive } from "./lib/closed.mjs";
import { readPackages, archivePackages } from "./lib/packages.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const CHECKED = join(dir, "closed-check-state.json");   // { url: lastCheckedISO }
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const maxPerRun = num(process.env.CLOSED_MAX, 150);
const recheckDays = num(process.env.CLOSED_RECHECK_DAYS, 3);
const archiveDays = num(process.env.CLOSED_ARCHIVE_DAYS, 14);

const packages = readPackages(APPS);
let checked = {};
try { checked = JSON.parse(readFileSync(CHECKED, "utf8")) || {}; } catch {}
const stateAtStart = readStoreOrExit(STATE, "skipping closed-vacancy check");

const todo = selectCandidates({ packages, stateMap: stateAtStart, checked, maxPerRun, recheckDays });
log(`closed-check: probing ${todo.length} of ${packages.length} package url(s)`);
const closed = [], closedUrls = [];
for (const { url, source } of todo) {
  let status = 0, html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (job-assistant)" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    status = res.status; html = status === 200 ? await res.text() : "";
  } catch (e) { log(`  · ${url} — ${e.message}`); continue; }   // network trouble: not checked, retried next run
  checked[url] = new Date().toISOString();
  if (isClosed({ source, status, html })) {
    closedUrls.push(url);   // applied to a FRESH read of the store below, not to stateAtStart
    const p = packages.find((x) => x.url === url);
    closed.push(p ? `${p.title} @ ${p.company}` : url);
    log(`  ✗ closed [${status}] ${source}: ${closed.at(-1)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
// The probe loop runs for minutes; dashboard clicks land on job-state.json
// meanwhile. Re-read the store now and apply only our patches, so the
// read-modify-write window is the microseconds between these two lines.
// ponytail: still a race with a click in that same instant; POST to the state
// server instead if it ever bites.
let stateMap = readStoreOrExit(STATE, "closed-check: store unreadable at the end of the run — closures not saved");
for (const url of closedUrls) stateMap = mergeEntry(stateMap, url, { status: "closed" });
if (closedUrls.length) {
  writeStore(STATE, stateMap);
  notify("Job assistant", `${closed.length} vacanc${closed.length === 1 ? "y" : "ies"} closed by the board — hidden from New`);
}
// Check stamps AFTER the store: a crash between the two must lose a re-probe, not a closure.
// Forget stamps for urls that no longer have a package (pruned) so the file stays bounded.
const live = new Set(packages.map((p) => p.url));
for (const u of Object.keys(checked)) if (!live.has(u)) delete checked[u];
writeJsonAtomic(CHECKED, checked);
const archived = archivePackages(APPS, planArchive({ packages, stateMap, closedDays: archiveDays }));
log(`closed-check: ${closed.length} closed, ${todo.length} probed, ${archived} package(s) archived (closed ${archiveDays}+ days)`);
