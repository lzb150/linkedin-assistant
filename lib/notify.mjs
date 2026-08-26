// Shared cross-platform notification helpers (previously copy-pasted in
// check.mjs, djinni-check.mjs, jobs.mjs and followup.mjs). macOS banners go
// through osascript, Linux through notify-send. All best-effort — a missing
// helper or command must never take the pipeline down.
import { existsSync } from "node:fs";
import { execFile as nodeExecFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_APP = join(ROOT, "Jobs.app"); // built by build-jobs.sh (macOS only)
const NOTIFIER_APP = join(ROOT, "Notifier.app"); // built by build-notifier.sh (macOS only)

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Per-platform banner command. Title/message ride as argv entries, never a
// shell string — they carry scraped job-board text.
export function notifyCommand(title, message, platform) {
  if (platform === "linux") return ["notify-send", [title, message]];
  return ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]];
}

// Banner on any platform; best-effort, never throws.
// (macOS: terminal-notifier shows no banners on macOS 26, hence osascript.)
export function notify(title, message, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = notifyCommand(title, message, platform);
  try { exec(cmd, args, () => {}); } catch {}
}

// Preferred banner: Notifier.app (green Messages icon) when built, osascript
// otherwise (Script Editor icon). The app MUST be launched via open(1) so
// macOS treats it as a registered app, detached + unref'd so the banner
// survives the calling process exiting.
export function notifyBanner(title, message, {
  platform = process.platform, app = NOTIFIER_APP, spawnFn = spawn, exec = nodeExecFile,
} = {}) {
  const fallback = () => notify(title, message, { platform, exec });
  if (platform !== "darwin" || !existsSync(app)) return fallback();
  try {
    const p = spawnFn("open", ["-n", "-a", app, "--args", title, message],
      { detached: true, stdio: "ignore" });
    p.on("error", (e) => { log("notify: Notifier.app failed, osascript fallback:", e?.message); fallback(); });
    p.unref();
  } catch (e) {
    log("notify: spawn threw, osascript fallback:", e?.message);
    fallback();
  }
}

// Keep the persistent Jobs.app badge daemon running so it can render the Dock
// badge. `--background` means "badge only, do not open the dashboard"; `-g`
// keeps focus on the user's current app.
// Guard: skip open(1) if Jobs.app is already running — calling open(1) on a
// running app triggers applicationShouldHandleReopen, which opens the dashboard.
export function ensureJobsApp() {
  if (process.platform !== "darwin") return; // the Jobs.app badge daemon is macOS-only
  if (!existsSync(JOBS_APP)) {
    log("notify: Jobs.app missing at", JOBS_APP, "— run ./build-jobs.sh");
    return;
  }
  if (spawnSync("pgrep", ["-x", "jobs"], { stdio: "ignore" }).status === 0) return;
  try {
    const p = spawn("open", ["-g", "-a", JOBS_APP, "--args", "--background"],
      { detached: true, stdio: "ignore" });
    p.on("error", (e) => log("notify: ensureJobsApp failed:", e?.message));
    p.unref();
  } catch (e) { log("notify: ensureJobsApp threw:", e?.message); }
}
