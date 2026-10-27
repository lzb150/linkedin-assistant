#!/usr/bin/env node
// Nightly backup of everything git does not hold: the application packages,
// drafts, every state file, the personal config and the launchd plists.
// Nothing here is re-creatable — a dead disk used to mean losing the whole
// application history. The browser profiles are left out on purpose (1.4 GB
// of Chromium cache; two manual `node login.mjs` runs bring them back).
//
//   node backup.mjs                       → ~/Library/Mobile Documents/com~apple~CloudDocs/linkedin-assistant-backup/
//   BACKUP_DIR=/Volumes/usb node backup.mjs
//
// One .tgz per day, named by date; the newest BACKUP_KEEP (14) are kept.
// Restore: docs/setup.md → "Back up (and restore)".
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log, notify } from "./lib/notify.mjs";
import { heartbeat } from "./lib/heartbeat.mjs";

// BACKUP_ROOT is a test seam (back up a prepared tmp tree); the real root is this directory.
const ROOT = process.env.BACKUP_ROOT || dirname(fileURLToPath(import.meta.url));
const DEST = process.env.BACKUP_DIR || join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/linkedin-assistant-backup");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

// Everything machine-local that the project cannot regenerate. Missing entries
// are skipped (no Djinni account → no djinni-*.json), never an error.
const ITEMS = [
  "applications", "drafts",
  "jobs.config.json", "skills.json", "resume.txt", "run.sh", "telegram.json",
  "job-state.json", "jobs-seen.json", "seen.json", "closed-check-state.json",
  "djinni-seen.json", "djinni-bump-state.json", "djinni-notify-state.json", "notify-state.json",
  "source-health.json", "run-stats.jsonl", "last-success.json",
];

const plists = readdirSync(ROOT).filter((f) => /^com\..+\.plist$/.test(f));
const present = [...ITEMS, ...plists].filter((f) => existsSync(join(ROOT, f)));
if (!present.length) { log(`backup: nothing to back up in ${ROOT}`); process.exit(1); }

const day = new Date().toISOString().slice(0, 10);
const name = `linkedin-assistant-${day}.tgz`;
const out = join(DEST, name);
const tmp = `${out}.tmp-${process.pid}`;
try {
  mkdirSync(DEST, { recursive: true, mode: 0o700 });
  // --no-xattrs: iCloud Drive refuses files whose xattrs it cannot sync, and the
  // archive needs none. Written to a tmp name and renamed so a run killed
  // mid-write never leaves a torn archive under the real name.
  execFileSync("tar", ["--no-xattrs", "-czf", tmp, "-C", ROOT, ...present], { stdio: ["ignore", "ignore", "pipe"] });
  renameSync(tmp, out);
} catch (e) {
  rmSync(tmp, { force: true });
  const why = String(e.stderr || e.message).trim().slice(-300);
  log(`backup: FAILED — ${why}`);
  notify("Job assistant", `⚠️ Backup failed: ${why}`);
  process.exit(1);
}
const size = statSync(out).size;

// Rotate: keep the newest KEEP archives (the date in the name sorts them).
const old = readdirSync(DEST).filter((f) => /^linkedin-assistant-\d{4}-\d{2}-\d{2}\.tgz$/.test(f)).sort().slice(0, -KEEP);
for (const f of old) { try { rmSync(join(DEST, f)); } catch (e) { log(`backup: could not remove ${f}: ${e.message}`); } }

log(`backup: ${name} (${(size / 1_048_576).toFixed(1)} MB, ${present.length} items) → ${DEST}; ${old.length} old archive(s) removed`);
heartbeat(join(ROOT, "last-success.json"), "backup", { log, alert: (m) => notify("Job assistant", m) });
