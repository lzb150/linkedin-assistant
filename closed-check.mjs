// closed-check.mjs
// Daily: probe New/Viewed DOU, Djinni and LinkedIn vacancies and mark the ones the board
// reports inactive as status "closed" in job-state.json, so they leave the
// dashboard's New and Viewed views. Plain GETs, one per second.
//   node closed-check.mjs             probe (up to 150 urls, each at most every 3 days)
//   CLOSED_MAX=50 CLOSED_RECHECK_DAYS=7 node closed-check.mjs
// Packages closed for 14+ days (CLOSED_ARCHIVE_DAYS) and Viewed packages left
// untouched for 30+ days (VIEWED_ARCHIVE_DAYS) are moved to applications/archive/,
// which nothing reads — keeps the dashboard small. Their job-state entries go
// with them (an entry without a live package is dead weight: 493 of 713 were).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStoreOrExit, writeStore, mergeEntry } from "./lib/job-state.mjs";
import { writeJsonAtomic, readJson } from "./lib/json-file.mjs";
import { log } from "./lib/notify.mjs";
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
const viewedDays = num(process.env.VIEWED_ARCHIVE_DAYS, 30);
// CLOSED_EXTRA_HOSTS='{"dou":"127.0.0.1"}' — extra allowed host per board (tests point a board at a local server).
let extraHosts = {};
try { extraHosts = JSON.parse(process.env.CLOSED_EXTRA_HOSTS || "{}") || {}; } catch {}

const packages = readPackages(APPS);
const checked = readJson(CHECKED, null) || {};
const stateAtStart = readStoreOrExit(STATE, "skipping closed-vacancy check");

const todo = selectCandidates({ packages, stateMap: stateAtStart, checked, maxPerRun, recheckDays, extraHosts });
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
// A status set while we were probing (a concurrent closed-check, a newer
// build's status) wins over the board's verdict — candidates were New/Viewed at the start, re-check now.
let saved = 0;
for (const url of closedUrls) {
  const st = stateMap[url]?.status;
  if (st && st !== "viewed") { log(`  · kept ${st}: ${url} (changed during the run)`); continue; }
  stateMap = mergeEntry(stateMap, url, { status: "closed" });
  saved++;
}
const toArchive = new Set(planArchive({ packages, stateMap, closedDays: archiveDays, viewedDays }));
// State entries for urls with no live package (archived now or earlier, pruned,
// or never had one) are dropped — if untouched for a day: a package jobs.mjs
// wrote during the probe, already clicked on the dashboard, is not in our
// package list yet and must survive. Only when packages/ read as non-empty: an
// unreadable applications/ must not wipe the store (cf. the 448-entry wipe).
const live = new Set(packages.filter((p) => !toArchive.has(p.file)).map((p) => p.url));
const staleBefore = Date.now() - 86400000;
const stale = (e) => { const t = Date.parse(e?.updatedAt || ""); return Number.isFinite(t) && t < staleBefore; };
let pruned = 0;
if (packages.length) for (const u of Object.keys(stateMap)) if (u !== "_meta" && !live.has(u) && stale(stateMap[u])) { delete stateMap[u]; pruned++; }
if (saved || pruned) writeStore(STATE, stateMap);
// Check stamps AFTER the store: a crash between the two must lose a re-probe, not a closure.
// Forget stamps for urls that no longer have a package (pruned) so the file stays bounded.
for (const u of Object.keys(checked)) if (!live.has(u)) delete checked[u];
writeJsonAtomic(CHECKED, checked);
const archived = archivePackages(APPS, [...toArchive]);
log(`closed-check: ${saved} closed, ${todo.length} probed, ${archived} package(s) archived (closed ${archiveDays}+ / viewed ${viewedDays}+ days), ${pruned} stale state entr${pruned === 1 ? "y" : "ies"} dropped`);
