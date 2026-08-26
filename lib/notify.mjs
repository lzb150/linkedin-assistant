// Shared cross-platform notification helpers (previously copy-pasted in
// check.mjs, djinni-check.mjs, jobs.mjs and followup.mjs). macOS banners are
// queued for Jobs.app (own icon, click opens the dashboard), falling back to
// osascript when it isn't built; Linux uses notify-send. All best-effort — a missing
// helper or command must never take the pipeline down.
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as nodeExecFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_APP = join(ROOT, "Jobs.app"); // built by build-jobs.sh (macOS only)
const BANNERS_DIR = join(ROOT, "banners"); // banner queue polled by Jobs.app

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Fallback banner command. Title/message ride as argv entries, never a shell
// string — they carry scraped job-board text. (macOS: osascript, Script Editor
// icon — terminal-notifier shows no banners on macOS 26; Linux: notify-send.)
function fallback(title, message, platform, exec) {
  const [cmd, args] = platform === "linux"
    ? ["notify-send", [title, message]]
    : ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]];
  try { exec(cmd, args, () => {}); } catch {}
}

// Banner on any platform; best-effort, never throws. macOS with Jobs.app
// built: queue a {title, message} file that the app posts under its own icon
// (click opens the dashboard). Otherwise the per-platform fallback command.
export function notify(title, message, {
  platform = process.platform, app = JOBS_APP, dir = BANNERS_DIR, exec = nodeExecFile, ensure = ensureJobsApp,
} = {}) {
  if (platform !== "darwin" || !existsSync(app)) return fallback(title, message, platform, exec);
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ title, message }));
    renameSync(`${file}.tmp`, file); // atomic: the daemon never reads a partial file
    ensure();
  } catch (e) {
    log("notify: banner queue failed, osascript fallback:", e?.message);
    fallback(title, message, platform, exec);
  }
}

// Keep the persistent Jobs.app badge daemon running so it can render the Dock
// badge. `--background` means "badge only, do not open the dashboard"; `-g`
// keeps focus on the user's current app.
// Guard: skip open(1) if Jobs.app is already running — calling open(1) on a
// running app triggers applicationShouldHandleReopen, which opens the dashboard.
export function ensureJobsApp(app = JOBS_APP) {
  if (process.platform !== "darwin") return; // the Jobs.app badge daemon is macOS-only
  if (!existsSync(app)) {
    log("notify: Jobs.app missing at", app, "— run ./build-jobs.sh");
    return;
  }
  // Match the full binary path: `-x jobs` also hits unrelated processes named "jobs".
  if (spawnSync("pgrep", ["-f", "Jobs.app/Contents/MacOS/jobs"], { stdio: "ignore" }).status === 0) return;
  try {
    const p = spawn("open", ["-g", "-a", app, "--args", "--background"],
      { detached: true, stdio: "ignore" });
    p.on("error", (e) => log("notify: ensureJobsApp failed:", e?.message));
    p.unref();
  } catch (e) { log("notify: ensureJobsApp threw:", e?.message); }
}
