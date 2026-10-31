// status.mjs
// One-screen health check, read-only: launchd agents, each job's last clean
// finish, what every source found lately, the state server, the queues and the
// dashboard's packages. Exit code 1 when a ✗ line needs a look.
//   npm run status
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson } from "./lib/json-file.mjs";
import { normalizeHeartbeat, staleJobs } from "./lib/heartbeat.mjs";
import { normalizeHistory, median } from "./lib/source-health.mjs";
import { readPackages } from "./lib/packages.mjs";
import { readStore } from "./lib/job-state.mjs";
import { readRunStats } from "./lib/run-stats.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
let problems = 0;

function line(mark, text) {
  if (mark === "✗") problems++;
  console.log(`  ${mark} ${text}`);
}

function ago(at) {
  const min = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

// A broken state file is a finding of its own, not a crash of the whole check.
function section(title, body) {
  console.log(`\n${title}`);
  try { body(); } catch (e) { line("✗", `unreadable: ${e.message}`); }
}

// The app's agents: one com.example.<name>.plist.example each (installed under
// your own label prefix). lid-awake is a system LaunchDaemon, not listed here.
function agents() {
  const names = readdirSync(dir).map((f) => /^com\.example\.(.+)\.plist\.example$/.exec(f)?.[1]).filter((n) => n && n !== "lid-awake");
  let listed;
  try { listed = execFileSync("launchctl", ["list"], { encoding: "utf8" }); } catch { return line("·", "launchctl not available — skipped"); }
  const rows = listed.split("\n").map((l) => l.split("\t"));
  for (const name of names) agentLine(name, rows.find((r) => r[2]?.endsWith(`.${name}`)));
}

// One agent's `launchctl list` row (pid, last exit, label) → its line; no row = not loaded.
function agentLine(name, [pid, exit] = []) {
  const label = name.padEnd(22);
  if (exit === undefined) return line("·", `${label} not loaded`);
  if (pid !== "-") return line("✓", `${label} running (pid ${pid})`);
  line(exit === "0" ? "✓" : "·", `${label} last exit ${exit}`);
}

// ✗ by the watchdog's own rule (old by the clock AND out-run by other jobs, so
// a sleeping Mac is not a dead job), without its once-a-day silence.
function runs() {
  const state = normalizeHeartbeat(readJson(join(dir, "last-success.json"), {}));
  const quiet = { ...state, jobs: Object.fromEntries(Object.entries(state.jobs).map(([n, j]) => [n, { at: j.at, tick: j.tick }])) };
  const stale = new Set(staleJobs(quiet, { now: new Date(now) }).map((s) => s.job));
  const names = Object.keys(state.jobs).sort();
  if (!names.length) return line("·", "no job has finished yet");
  for (const n of names) line(stale.has(n) ? "✗" : "✓", `${n.padEnd(22)} ${ago(state.jobs[n].at)}${stale.has(n) ? " — stopped finishing; is its launchd agent loaded?" : ""}`);
}

// One run at 0 is usually a DarkWake with no network; two in a row against a
// normal median is the board or its parser.
function sources() {
  const history = normalizeHistory(readJson(join(dir, "source-health.json"), {}));
  if (!Object.keys(history).length) return line("·", "no run recorded yet");
  for (const [name, counts] of Object.entries(history)) {
    const down = counts.length >= 2 && counts.at(-1) === 0 && counts.at(-2) === 0 && median(counts) > 0;
    line(down ? "✗" : "✓", `${name.padEnd(22)} ${counts.at(-1) ?? "—"} found (median ${median(counts)})${down ? " — 0 twice in a row" : ""}`);
  }
}

async function stateServer() {
  console.log("\nState server");
  try {
    const res = await fetch("http://127.0.0.1:7777/health", { signal: AbortSignal.timeout(1500) });
    line(res.ok ? "✓" : "✗", `127.0.0.1:7777 answers ${res.status}`);
  } catch (e) {
    line("✗", `127.0.0.1:7777 not answering (${e.cause?.code || e.name}) — card edits stay in the browser; restart its launchd agent`);
  }
}

function queues() {
  const pending = join(dir, "linkedin-pending");
  line("·", existsSync(pending) ? `LinkedIn deferred ${ago(statSync(pending).mtime.toISOString())}; the catch-up agent runs it once the Mac is awake` : "LinkedIn: nothing deferred");
  const outbox = join(dir, "telegram-outbox");
  const queued = existsSync(outbox) ? readdirSync(outbox).filter((f) => f.endsWith(".json")).length : 0;
  line("·", `Telegram outbox: ${queued} queued`);
  const last = readRunStats(join(dir, "run-stats.jsonl")).at(-1);
  if (last) line("·", `last jobs run ${ago(last.at)}: ${last.considered} considered, ${last.written} written, ${last.failed} failed`);
}

function packages() {
  const apps = join(dir, "applications");
  const state = readStore(join(dir, "job-state.json"));
  const by = { new: 0, viewed: 0, closed: 0 };
  let borderline = 0;
  for (const p of readPackages(apps)) {
    const status = state[p.url]?.status || "new";
    by[status] = (by[status] || 0) + 1;
    if (p.tier === "borderline") borderline++;
  }
  const archived = existsSync(join(apps, "archive")) ? readdirSync(join(apps, "archive")).filter((f) => f.endsWith(".md")).length : 0;
  line("·", `${by.new} new, ${by.viewed} viewed, ${by.closed} closed${borderline ? ` (${borderline} borderline)` : ""}; ${archived} archived`);
}

console.log(`linkedin-assistant status — ${new Date(now).toLocaleString("en-GB")}`);
section("Launchd agents", agents);
section("Last clean finish", runs);
section("Sources (last run)", sources);
await stateServer();
section("Queues", queues);
section("Dashboard packages", packages);
console.log(problems ? `\n${problems} problem(s) — see ✗ above.` : "\nAll good.");
process.exitCode = problems ? 1 : 0;
