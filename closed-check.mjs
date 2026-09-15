// closed-check.mjs
// Daily: probe New/Viewed DOU, Djinni and LinkedIn vacancies and mark the ones the board
// reports inactive as status "closed" in job-state.json, so they leave the
// dashboard's New and Viewed views. Plain GETs, one per second.
//   node closed-check.mjs             probe (up to 150 urls, each at most every 3 days)
// Packages closed for 14+ days and Viewed packages left untouched for 30+ days
// are moved to applications/archive/,
// which nothing reads — keeps the dashboard small. Their job-state entries go
// with them (an entry without a live package is dead weight: 493 of 713 were).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStoreOrExit, writeStore, mergeEntry } from "./lib/job-state.mjs";
import { writeJsonAtomic, readJson } from "./lib/json-file.mjs";
import { log } from "./lib/notify.mjs";
import { isClosed, selectCandidates, planArchive } from "./lib/closed.mjs";
import { bodyText } from "./lib/sources/html.mjs";
import { readPackages, archivePackages } from "./lib/packages.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const CHECKED = join(dir, "closed-check-state.json");   // { url: lastCheckedISO }

const packages = readPackages(APPS);
const checked = readJson(CHECKED, null) || {};
const stateAtStart = readStoreOrExit(STATE, "skipping closed-vacancy check");

const todo = selectCandidates({ packages, stateMap: stateAtStart, checked });   // 150 per run, each url at most every 3 days
log(`closed-check: probing ${todo.length} of ${packages.length} package url(s)`);
const byUrl = new Map(packages.map((p) => [p.url, p]));

// The probe loop runs for minutes; dashboard clicks land on job-state.json
// meanwhile. Closures are applied to a FRESH read of the store (never to
// stateAtStart), so the read-modify-write window is the microseconds between
// the read and the write. A status set while we were probing (a concurrent
// closed-check, a newer build's status) wins over the board's verdict —
// candidates were New/Viewed at the start, re-check now.
// ponytail: still a race with a click in that same instant; POST to the state
// server instead if it ever bites.
let pending = [];   // closed urls not yet applied to the store
let saved = 0;
function applyClosures(stateMap) {
  let n = 0;
  for (const url of pending) {
    const st = stateMap[url]?.status;
    if (st && st !== "viewed") { log(`  · kept ${st}: ${url} (changed during the run)`); continue; }
    stateMap = mergeEntry(stateMap, url, { status: "closed" });
    n++;
  }
  pending = [];
  saved += n;
  return { stateMap, n };
}
// Store first, check stamps after: a crash between the two must lose a
// re-probe, not a closure. Every 25 probes, not only at the end — a 150-url
// run takes minutes, and a crash or a Mac falling asleep mid-run used to lose
// every closure found so far.
function flush() {
  const { stateMap, n } = applyClosures(readStoreOrExit(STATE, "closed-check: store unreadable mid-run — closures not saved"));
  if (n) writeStore(STATE, stateMap);
  writeJsonAtomic(CHECKED, checked);
}

let probed = 0;
for (const { url, source } of todo) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (job-assistant)" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    const status = res.status, html = status === 200 ? await bodyText(res) : "";
    checked[url] = new Date().toISOString();
    if (isClosed({ source, status, html })) {
      pending.push(url);
      const p = byUrl.get(url);
      log(`  ✗ closed [${status}] ${source}: ${p ? `${p.title} @ ${p.company}` : url}`);
    }
  } catch (e) { log(`  · ${url} — ${e.message}`); }   // network trouble: not checked, retried next run
  // Politeness pause after EVERY probe, failed ones too (a `continue` in the
  // catch used to skip it and hammer a board during a network blip).
  await new Promise((r) => setTimeout(r, 1000));
  if (++probed % 25 === 0) flush();
}
let { stateMap, n: savedNow } = applyClosures(readStoreOrExit(STATE, "closed-check: store unreadable at the end of the run — closures not saved"));
// Archive BEFORE pruning, and prune by what actually moved: a package whose
// rename failed is still in applications/ and needs its state entry, or it
// reappears as New on the dashboard.
const archived = new Set(archivePackages(APPS, planArchive({ packages, stateMap }), { warn: (f, e) => log(`  · could not archive ${f}, keeping it: ${e.message}`) }));   // closed 14+ / viewed 30+ days
// State entries for urls with no live package (archived now or earlier, pruned,
// or never had one) are dropped — if untouched for a day: a package jobs.mjs
// wrote during the probe, already clicked on the dashboard, is not in our
// package list yet and must survive. Only when packages/ read as non-empty: an
// unreadable applications/ must not wipe the store (cf. the 448-entry wipe).
const live = new Set(packages.filter((p) => !archived.has(p.file)).map((p) => p.url));
const staleBefore = Date.now() - 86400000;
const stale = (e) => { const t = Date.parse(e?.updatedAt || ""); return Number.isFinite(t) && t < staleBefore; };
let pruned = 0;
if (packages.length) for (const u of Object.keys(stateMap)) if (u !== "_meta" && !live.has(u) && stale(stateMap[u])) { delete stateMap[u]; pruned++; }
if (savedNow || pruned) writeStore(STATE, stateMap);
// Check stamps AFTER the store: a crash between the two must lose a re-probe, not a closure.
// Forget stamps for urls that no longer have a package (pruned) so the file stays bounded.
if (packages.length) for (const u of Object.keys(checked)) if (!live.has(u)) delete checked[u];
writeJsonAtomic(CHECKED, checked);
log(`closed-check: ${saved} closed, ${todo.length} probed, ${archived.size} package(s) archived (closed 14+ / viewed 30+ days), ${pruned} stale state entr${pruned === 1 ? "y" : "ies"} dropped`);
