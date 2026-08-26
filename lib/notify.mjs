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

// Per-platform banner command. Title/message ride as argv entries, never a
// shell string — they carry scraped job-board text.
export function notifyCommand(title, message, platform) {
  if (platform === "linux") return ["notify-send", [title, message]];
  return ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]];
}

// Banner on any platform; best-effort, never throws.
// (macOS: osascript fallback — terminal-notifier shows no banners on macOS 26.)
export function notify(title, message, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = notifyCommand(title, message, platform);
  try { exec(cmd, args, () => {}); } catch {}
}

// Preferred banner: queue a {title, message} file for Jobs.app, which posts it
// under its own icon and opens the dashboard on click. Fallback: osascript
// (Script Editor icon, click opens Script Editor) when Jobs.app isn't built.
export function notifyBanner(title, message, {
  platform = process.platform, app = JOBS_APP, dir = BANNERS_DIR, exec = nodeExecFile, ensure = ensureJobsApp,
} = {}) {
  if (platform !== "darwin" || !existsSync(app)) return notify(title, message, { platform, exec });
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ title, message }));
    renameSync(`${file}.tmp`, file); // atomic: the daemon never reads a partial file
    ensure();
  } catch (e) {
    log("notify: banner queue failed, osascript fallback:", e?.message);
    notify(title, message, { platform, exec });
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
  if (spawnSync("pgrep", ["-x", "jobs"], { stdio: "ignore" }).status === 0) return;
  try {
    const p = spawn("open", ["-g", "-a", app, "--args", "--background"],
      { detached: true, stdio: "ignore" });
    p.on("error", (e) => log("notify: ensureJobsApp failed:", e?.message));
    p.unref();
  } catch (e) { log("notify: ensureJobsApp threw:", e?.message); }
}
