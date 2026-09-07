// closed-check.mjs
// Daily: probe New/Viewed DOU, Djinni and LinkedIn vacancies and mark the ones the board
// reports inactive as status "closed" in job-state.json, so they leave the
// dashboard's New view and never reach a follow-up. Plain GETs, one per second.
//   node closed-check.mjs             probe (up to 150 urls, each at most every 3 days)
//   CLOSED_MAX=50 CLOSED_RECHECK_DAYS=7 node closed-check.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStoreOrExit, writeStore, mergeEntry } from "./lib/job-state.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { writeJsonAtomic } from "./lib/json-file.mjs";
import { notify, log } from "./lib/notify.mjs";
import { isClosed, selectCandidates } from "./lib/closed.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const CHECKED = join(dir, "closed-check-state.json");   // { url: lastCheckedISO }
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const maxPerRun = num(process.env.CLOSED_MAX, 150);
const recheckDays = num(process.env.CLOSED_RECHECK_DAYS, 3);

const packages = (existsSync(APPS) ? readdirSync(APPS) : []).filter((f) => f.endsWith(".md")).flatMap((f) => {
  try { const fm = parseFrontmatter(readFileSync(join(APPS, f), "utf8")) || {}; return [{ url: fm.url, source: fm.source, title: fm.title, company: fm.company }]; }
  catch { return []; }
});
let checked = {};
try { checked = JSON.parse(readFileSync(CHECKED, "utf8")) || {}; } catch {}
let stateMap = readStoreOrExit(STATE, "skipping closed-vacancy check");

const todo = selectCandidates({ packages, stateMap, checked, maxPerRun, recheckDays });
log(`closed-check: probing ${todo.length} of ${packages.length} package url(s)`);
const closed = [];
for (const { url, source } of todo) {
  let status = 0, html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (job-assistant)" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    status = res.status; html = status === 200 ? await res.text() : "";
  } catch (e) { log(`  · ${url} — ${e.message}`); continue; }   // network trouble: not checked, retried next run
  checked[url] = new Date().toISOString();
  if (isClosed({ source, status, html })) {
    // ponytail: read-modify-write races a dashboard click landing in the same
    // second; go through the state server's POST if that ever bites.
    stateMap = mergeEntry(stateMap, url, { status: "closed" });
    const p = packages.find((x) => x.url === url);
    closed.push(p ? `${p.title} @ ${p.company}` : url);
    log(`  ✗ closed [${status}] ${source}: ${closed.at(-1)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
// Forget check stamps for urls that no longer have a package (pruned) so the file stays bounded.
const live = new Set(packages.map((p) => p.url));
for (const u of Object.keys(checked)) if (!live.has(u)) delete checked[u];
writeJsonAtomic(CHECKED, checked);
if (closed.length) {
  writeStore(STATE, stateMap);
  notify("Job assistant", `${closed.length} vacanc${closed.length === 1 ? "y" : "ies"} closed by the board — hidden from New`);
}
log(`closed-check: ${closed.length} closed, ${todo.length} probed`);
