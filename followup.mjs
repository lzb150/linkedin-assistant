// followup.mjs
// Daily reminder: notify about jobs marked "applied" with no movement for N days.
// Notifications go through lib/notify.mjs (Jobs.app banner, osascript fallback).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./lib/json-file.mjs";
import { readStoreOrExit } from "./lib/job-state.mjs";
import { dueReminders } from "./lib/followup.mjs";
import { notify } from "./lib/notify.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const DEDUPE = join(dir, "followup-notify-state.json");
const envDays = Number(process.env.FOLLOWUP_DAYS);
const THRESHOLD_DAYS = Number.isFinite(envDays) && envDays > 0 ? envDays : 7;

// Map url -> { title, company } from the application packages.
function jobIndex() {
  const idx = {};
  // applications/ does not exist before the first jobs.mjs run — no packages, no index.
  for (const f of (existsSync(APPS) ? readdirSync(APPS) : []).filter((x) => x.endsWith(".md"))) {
    // One unreadable package must not kill the whole reminder run.
    let fm;
    try { fm = parseFrontmatter(readFileSync(join(APPS, f), "utf8")) || {}; }
    catch (e) { console.log(`followup: unreadable package skipped: ${f} (${e.message})`); continue; }
    if (fm.url) idx[fm.url] = { title: fm.title || "", company: fm.company || "" };
  }
  return idx;
}

// Dedupe per calendar day: { day: "YYYY-MM-DD", urls: [...] }.
function loadDedupe(today) {
  try { const d = JSON.parse(readFileSync(DEDUPE, "utf8")); if (d.day === today) return Array.isArray(d.urls) ? d.urls : []; } catch {}
  return [];
}
const saveDedupe = (today, urls) => writeJsonAtomic(DEDUPE, { day: today, urls });

// Local calendar day (toISOString is UTC and rolls over at a different hour).
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const already = loadDedupe(today);
const stateMap = readStoreOrExit(STATE, "skipping follow-up run");
const due = dueReminders({ stateMap, now: new Date(), thresholdDays: THRESHOLD_DAYS, alreadyNotified: already });
const idx = jobIndex();

for (const { url, daysSince } of due) {
  const j = idx[url] || {};
  const where = j.company || j.title || "a job";
  notify("Follow up on your application", `${where} — applied ${daysSince}d ago, no reply yet`);
  already.push(url);
}
saveDedupe(today, already);
console.log(`followup: ${due.length} reminder(s) fired`);
