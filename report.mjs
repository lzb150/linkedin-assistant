// report.mjs
// Weekly digest: runs and new vacancies considered, packages per source, LLM verdicts,
// and per-source yield for the last N days (default 7).
//   node report.mjs              print to stdout
//   node report.mjs --notify     also post a macOS banner and send the digest to Telegram (launchd job)
//   REPORT_DAYS=14 node report.mjs
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { readPackages } from "./lib/packages.mjs";
import { readJson } from "./lib/json-file.mjs";
import { normalizeHistory } from "./lib/source-health.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { notify } from "./lib/notify.mjs";
import { queueTelegram, alertMessage } from "./lib/telegram.mjs";
import { buildReport } from "./lib/report.mjs";
import { readRunStats } from "./lib/run-stats.mjs";
import { heartbeat } from "./lib/heartbeat.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const envDays = Number(process.env.REPORT_DAYS);
const days = Number.isFinite(envDays) && envDays > 0 ? envDays : 7;
const now = new Date();
const since = now.getTime() - days * 86400000;

const packages = readPackages(join(dir, "applications"));
// jobs.mjs logs (run.sh: jobs_<date>.log, jobs_dou_<date>.log; jobs_full_ before 2026-09-11) touched inside the window.
const logsDir = join(dir, "logs");
const logText = (existsSync(logsDir) ? readdirSync(logsDir) : [])
  // run.sh rotates logs with `find -mtime +30 -delete`; a file unlinked between
  // readdir and the READ must not kill the report either — with REPORT_DAYS over
  // 30 a log old enough to be swept still passes the mtime filter.
  .flatMap((f) => { try { return /^jobs_(dou_|full_)?\d{8}\.log$/.test(f) && statSync(join(logsDir, f)).mtimeMs >= since ? [readFileSync(join(logsDir, f), "utf8")] : []; } catch { return []; } })
  .join("\n");

const { text, notification } = buildReport({
  now, days,
  packages,
  logText,
  runStats: readRunStats(join(dir, "run-stats.jsonl"), { since }),
  // The report writes nothing, so an unreadable health file only costs this
  // one section — say so and carry on rather than killing the digest.
  health: normalizeHistory((() => {
    try { return readJson(join(dir, "source-health.json"), {}); }
    catch (e) { console.error(`⚠ source-health.json unreadable (${e.message}) — the health section is empty`); return {}; }
  })()),
});
console.log(text);
// The banner gets the one-liner (a macOS banner shows ~2 lines); the phone gets
// the whole digest — it used to get the one-liner too, and the per-source
// lines stayed in logs/report.out.log, the one place nobody looks on a Monday.
if (process.argv.includes("--notify")) {
  notify("Weekly job report", notification, { toTelegram: false });
  queueTelegram(alertMessage("Weekly job report", text));
  // Only the scheduled run counts as the weekly job finishing; a digest run by hand does not.
  heartbeat(join(dir, "last-success.json"), "report", { log: console.error, alert: (m) => notify("Job assistant", m) });
}
