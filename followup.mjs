// followup.mjs
// Daily reminder: notify about jobs marked "applied" with no movement for N days.
// Notifications go through osascript (terminal-notifier shows no banners on macOS 26).
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStore } from "./lib/job-state.mjs";
import { dueReminders } from "./lib/followup.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const DEDUPE = join(dir, "followup-notify-state.json");
const envDays = Number(process.env.FOLLOWUP_DAYS);
const THRESHOLD_DAYS = Number.isFinite(envDays) && envDays > 0 ? envDays : 7;

// Map url -> { title, company } from the application packages.
function jobIndex() {
  const idx = {};
  for (const f of readdirSync(APPS).filter((x) => x.endsWith(".md"))) {
    const md = readFileSync(join(APPS, f), "utf8");
    const fm = (md.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
    const get = (k) => (fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) || [])[1]?.trim() || "";
    const url = get("url");
    if (url) idx[url] = { title: get("title"), company: get("company") };
  }
  return idx;
}

// Dedupe per calendar day: { day: "YYYY-MM-DD", urls: [...] }.
function loadDedupe(today) {
  try { const d = JSON.parse(readFileSync(DEDUPE, "utf8")); if (d.day === today) return d.urls || []; } catch {}
  return [];
}
function saveDedupe(today, urls) {
  const tmp = `${DEDUPE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ day: today, urls }, null, 0));
  renameSync(tmp, DEDUPE);
}

function notify(title, body) {
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
  execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`]);
}

const today = new Date().toISOString().slice(0, 10);
const already = loadDedupe(today);
const due = dueReminders({ stateMap: readStore(STATE), now: new Date(), thresholdDays: THRESHOLD_DAYS, alreadyNotified: already });
const idx = jobIndex();

for (const { url, daysSince } of due) {
  const j = idx[url] || {};
  const where = j.company || j.title || "a job";
  notify("Follow up on your application", `${where} — applied ${daysSince}d ago, no reply yet`);
  already.push(url);
}
saveDedupe(today, already);
console.log(`followup: ${due.length} reminder(s) fired`);
