// report.mjs
// Weekly digest: runs and new vacancies considered, packages per source, LLM verdicts,
// pipeline movement and per-source yield for the last N days (default 7).
//   node report.mjs              print to stdout
//   node report.mjs --notify     also post a macOS notification (launchd job)
//   REPORT_DAYS=14 node report.mjs
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { readPackages } from "./lib/packages.mjs";
import { readJson as readJsonFile } from "./lib/json-file.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStoreOrExit } from "./lib/job-state.mjs";
import { notify } from "./lib/notify.mjs";
import { buildReport } from "./lib/report.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const envDays = Number(process.env.REPORT_DAYS);
const days = Number.isFinite(envDays) && envDays > 0 ? envDays : 7;
const now = new Date();
const since = now.getTime() - days * 86400000;

const readJson = (f) => readJsonFile(join(dir, f), {});
const files = (sub, ext) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((x) => x.endsWith(ext)).map((x) => join(dir, sub, x)) : []);

const packages = readPackages(join(dir, "applications"));
// Only log files touched inside the window (daily files since Sep 2026, per-run before).
const logText = files("logs", ".log")
  .filter((f) => /jobs_(dou|full)_/.test(f) && statSync(f).mtimeMs >= since)
  .map((f) => readFileSync(f, "utf8")).join("\n");

const { text, notification } = buildReport({
  now, days,
  packages,
  stateMap: readStoreOrExit(join(dir, "job-state.json"), "skipping weekly report"),
  logText,
  health: readJson("source-health.json"),
});
console.log(text);
if (process.argv.includes("--notify")) notify("Weekly job report", notification);
