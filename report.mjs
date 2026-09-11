// report.mjs
// Weekly digest: runs and new vacancies considered, packages per source, LLM verdicts,
// and per-source yield for the last N days (default 7).
//   node report.mjs              print to stdout
//   node report.mjs --notify     also post a macOS notification (launchd job)
//   REPORT_DAYS=14 node report.mjs
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { readPackages } from "./lib/packages.mjs";
import { readJson as readJsonFile } from "./lib/json-file.mjs";
import { normalizeHistory } from "./lib/source-health.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { notify } from "./lib/notify.mjs";
import { buildReport } from "./lib/report.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const envDays = Number(process.env.REPORT_DAYS);
const days = Number.isFinite(envDays) && envDays > 0 ? envDays : 7;
const now = new Date();
const since = now.getTime() - days * 86400000;

const packages = readPackages(join(dir, "applications"));
// jobs.mjs logs (run.sh: jobs_<date>.log, jobs_dou_<date>.log; jobs_full_ before 2026-09-11) touched inside the window.
const logsDir = join(dir, "logs");
const logText = (existsSync(logsDir) ? readdirSync(logsDir) : [])
  .filter((f) => /^jobs_(dou_|full_)?\d{8}\.log$/.test(f) && statSync(join(logsDir, f)).mtimeMs >= since)
  .map((f) => readFileSync(join(logsDir, f), "utf8")).join("\n");

const { text, notification } = buildReport({
  now, days,
  packages,
  logText,
  health: normalizeHistory(readJsonFile(join(dir, "source-health.json"), {})),
});
console.log(text);
if (process.argv.includes("--notify")) notify("Weekly job report", notification);
