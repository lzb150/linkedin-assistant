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
import { log, notify } from "./lib/notify.mjs";
import { heartbeat } from "./lib/heartbeat.mjs";
import { isClosed, selectCandidates, planArchive, onBoardHost, MARKER_LANG } from "./lib/closed.mjs";
import { bodyText, discardBody, fetchFollow } from "./lib/sources/html.mjs";
import { readPackages, archivePackages } from "./lib/packages.mjs";
import { acquireProfileLock } from "./lib/run-lock.mjs";

const dir = dirname(fileURLToPath(import.meta.url));

// Run-wide lock, for the same reason jobs.mjs takes one: the probe loop runs for
// minutes (1 req/s over up to 150 urls), so a manual run easily overlaps the
// scheduled one. Each held its own in-memory `checked` map and wrote it whole,
// so the last writer won and the other run's fresh stamps vanished — both then
// re-probed the same urls the next day. (job-state.json was already safe: those
// writes re-read and replay. The stamp file was not.)
// Second run exits quietly with 0, so launchd does not flag a benign overlap.
try {
  acquireProfileLock(join(dir, "closed-check"));
} catch (e) {
  if (!/profile busy/.test(e.message)) throw e;
  log("another closed-check.mjs run is active — exiting");
  process.exit(0);
}

const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const CHECKED = join(dir, "closed-check-state.json");   // { url: lastCheckedISO }
const HEARTBEAT_FILE = join(dir, "last-success.json");

// A package readPackages could not read is absent from `packages`, so it looks
// dead to both prunes below and its card would come back as New with its
// status lost. Any such skip makes this run's view partial — prune nothing.
let partialRead = false;
const packages = readPackages(APPS, { warn: (f, e) => { partialRead = true; log(`  · could not read ${f}: ${e.message}`); } });
const mayPrune = () => packages.length && !partialRead;
// Re-check stamps. An unreadable file must not become an empty one: writing
// this run's ~150 stamps over the accumulated set made every other url look
// never-probed, so the next run re-probed boards it had just probed — and the
// fresh stamps hid the loss. Keep it untouched and stop stamping for this run.
let checked = {};
let checkedReadable = true;
try {
  checked = readJson(CHECKED, null) || {};
} catch (e) {
  checkedReadable = false;
  log(`⚠ ${CHECKED} unreadable (${e.message}) — re-check stamps are not updated this run and the file is left untouched; fix or delete it`);
}
const saveChecked = () => { if (checkedReadable) writeJsonAtomic(CHECKED, checked); };

// The dashboard edits job-state.json through the state server (POST /state:
// one read-modify-write per request, serialised on its event loop), and this
// script used to write the file beside it — a click landing in the
// microseconds between our read and our write was lost. So while the server
// answers GET /health, every edit goes through it, one POST each with the
// payload a dashboard click sends, and the file is never written from here. A
// server that is down (launchd restarting it) takes the direct path, as
// before; one that goes away mid-run flips to it with a line in the log.
// Test seam: STATE_SERVER points at a server on another port.
const STATE_SERVER = process.env.STATE_SERVER || "http://127.0.0.1:7777";
let viaServer = await (async () => {
  try {
    const res = await fetch(`${STATE_SERVER}/health`, { signal: AbortSignal.timeout(1000) });
    await discardBody(res);
    return res.status === 200;
  } catch { return false; }
})();
async function serverRead() {
  const res = await fetch(`${STATE_SERVER}/state`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) { await discardBody(res); throw new Error(`GET /state ${res.status}`); }
  return res.json();
}
async function serverPatch(url, patch) {
  const res = await fetch(`${STATE_SERVER}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, patch }), signal: AbortSignal.timeout(5000) });
  await discardBody(res);
  if (!res.ok) throw new Error(`POST /state ${res.status}`);
}
const direct = (e) => { viaServer = false; log(`  · state server went away (${e.message}) — writing job-state.json directly`); };
// The store as it is NOW: the server's copy while it is up, else the file.
async function readLive(reason) {
  if (viaServer) { try { return await serverRead(); } catch (e) { direct(e); } }
  return readStoreOrExit(STATE, reason);
}
// A batch of edits — [{ url, patch }], each the payload a dashboard click
// sends — into the store: one POST each through the server, or merged into
// the fresh `map` and written once.
async function save(map, edits) {
  if (!edits.length) return;
  if (viaServer) { try { for (const { url, patch } of edits) await serverPatch(url, patch); return; } catch (e) { direct(e); } }
  for (const { url, patch } of edits) map = mergeEntry(map, url, patch);
  writeStore(STATE, map);
}
const CLOSE = { status: "closed" };
// The dashboard's own clearing patch: an entry with neither status nor note
// is dropped by the store (mergeEntry), which is how a prune deletes one.
const CLEAR = { status: "new", note: "" };

const stateAtStart = await readLive("skipping closed-vacancy check");

const todo = selectCandidates({ packages, stateMap: stateAtStart, checked });   // 150 per run, each url at most every 3 days
log(`closed-check: probing ${todo.length} of ${packages.length} package url(s)`);
const byUrl = new Map(packages.map((p) => [p.url, p]));

// The probe loop runs for minutes; dashboard clicks land on the store
// meanwhile. Closures are decided against a FRESH read of it (never against
// stateAtStart): a status set while we were probing (a concurrent
// closed-check, a newer build's status) wins over the board's verdict —
// candidates were New/Viewed at the start, re-check now.
let pending = [];   // closed urls not yet applied to the store
let saved = 0;
// The one "may we still close this url?" rule, re-decided against whatever the
// store holds now: only a candidate still New (no entry) or Viewed may be
// closed, so any status set while we were probing wins. Both the mid-run flush
// and the final replay below ask this, and they used to spell it two inverted ways.
const closable = (map, url) => { const st = map[url]?.status; return !st || st === "viewed"; };
// The closures of `pending` still allowed against `map`, as edits; the rest
// are reported. Empties `pending` and counts the allowed ones as saved.
function closures(map) {
  const edits = [];
  for (const url of pending) {
    if (!closable(map, url)) { log(`  · kept ${map[url].status}: ${url} (changed during the run)`); continue; }
    edits.push({ url, patch: CLOSE });
  }
  pending = [];
  saved += edits.length;
  return edits;
}
// Store first, check stamps after: a crash between the two must lose a
// re-probe, not a closure. Every 25 probes, not only at the end — a 150-url
// run takes minutes, and a crash or a Mac falling asleep mid-run used to lose
// every closure found so far.
async function flush() {
  const map = await readLive("closed-check: store unreadable mid-run — closures not saved");
  await save(map, closures(map));
  saveChecked();
}

let probed = 0;
for (const { url, source } of todo) {
  try {
    // Every redirect hop is re-checked against the board host, not just the
    // frontmatter url: an open redirect on a board would otherwise aim this
    // daily job at anything the Mac can reach, the loopback state server included.
    // Accept-Language names the marker's language (lib/closed.mjs).
    const res = await fetchFollow(url, { headers: { "User-Agent": "Mozilla/5.0 (job-assistant)", "Accept-Language": MARKER_LANG[source] }, signal: AbortSignal.timeout(15_000) }, { allow: (u) => onBoardHost(source, u) });
    const status = res.status, html = status === 200 ? await bodyText(res) : (await discardBody(res), "");
    // Stamp only a real answer about the vacancy. A 429/5xx/Cloudflare page says
    // nothing, and a stamp would park the url for the whole re-check window.
    if (status === 200 || status === 404 || status === 410) checked[url] = new Date().toISOString();
    if (isClosed({ source, status, html })) {
      pending.push(url);
      const p = byUrl.get(url);
      log(`  ✗ closed [${status}] ${source}: ${p ? `${p.title} @ ${p.company}` : url}`);
    }
  } catch (e) { log(`  · ${url} — ${e.message}`); }   // network trouble: not checked, retried next run
  // Politeness pause after EVERY probe, failed ones too (a `continue` in the
  // catch used to skip it and hammer a board during a network blip).
  await new Promise((r) => setTimeout(r, 1000));
  if (++probed % 25 === 0) await flush();
}
const closedNow = pending.slice();   // closures() empties `pending`; kept to replay onto a fresher store below
// Decided now, written below together with the prune: planArchive and the
// prune count want the store as it will be once the closures are in.
let stateMap = await readLive("closed-check: store unreadable at the end of the run — closures not saved");
const closing = closures(stateMap);
const savedNow = closing.length;
for (const { url, patch } of closing) stateMap = mergeEntry(stateMap, url, patch);
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
// A missing updatedAt counts as old enough — the same reading planArchive uses.
// While the two disagreed, a legacy entry could be archived and then never
// pruned, so it sat in the store forever with no package behind it.
const stale = (e) => { const t = Date.parse(e?.updatedAt || ""); return !Number.isFinite(t) || t < staleBefore; };
const prunable = (map, u) => u !== "_meta" && !live.has(u) && stale(map[u]);
// Counted on the map we actually write, not on the one read before the renames:
// the first pass used to prune `stateMap`, which is then thrown away, so the
// logged number could disagree with what was really removed.
const wouldPrune = mayPrune() ? Object.keys(stateMap).filter((u) => prunable(stateMap, u)).length : 0;
let pruned = 0;
if (savedNow || wouldPrune) {
  // archivePackages just spent one renameSync per archived package, and a
  // dashboard click lands on the store meanwhile. Writing the map read before
  // those renames would clobber it, so re-read now and replay our own two
  // edits — the closures and the prune — onto whatever is there. Both are
  // re-decided against the fresh entry, so a status set in the window wins.
  const out = await readLive("closed-check: store unreadable before the final write — closures not saved");
  const edits = closedNow.filter((u) => closable(out, u)).map((url) => ({ url, patch: CLOSE }));
  if (mayPrune()) for (const url of Object.keys(out)) if (prunable(out, url)) { edits.push({ url, patch: CLEAR }); pruned++; }
  await save(out, edits);
}
// Check stamps AFTER the store: a crash between the two must lose a re-probe, not a closure.
// Forget stamps for urls that no longer have a package (pruned) so the file stays bounded.
if (mayPrune()) for (const u of Object.keys(checked)) if (!live.has(u)) delete checked[u];
saveChecked();
log(`closed-check: ${saved} closed, ${todo.length} probed, ${archived.size} package(s) archived (closed 14+ / viewed 30+ days), ${pruned} stale state entr${pruned === 1 ? "y" : "ies"} dropped`);
heartbeat(HEARTBEAT_FILE, "closed-check", { log, alert: (m) => notify("Job assistant", m) });
