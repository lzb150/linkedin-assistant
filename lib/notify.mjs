// Shared cross-platform notification helpers (previously copy-pasted in
// check.mjs, djinni-check.mjs, jobs.mjs and followup.mjs). macOS banners go
// through osascript, Windows through scripts/windows/toast.ps1 (WinRT toast),
// Linux through notify-send. All best-effort — a missing helper or command
// must never take the pipeline down.
import { existsSync } from "node:fs";
import { execFile as nodeExecFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_APP = join(ROOT, "Jobs.app"); // built by build-jobs.sh (macOS only)
const TOAST_PS1 = join(ROOT, "scripts", "windows", "toast.ps1");

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Per-platform banner command. Title/message ride as argv entries, never a
// shell string — they carry scraped job-board text.
export function notifyCommand(title, message, platform) {
  if (platform === "win32") {
    return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TOAST_PS1, "-Title", title, "-Message", message]];
  }
  if (platform === "linux") return ["notify-send", [title, message]];
  return ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]];
}

// Banner on any platform; best-effort, never throws.
// (macOS: terminal-notifier shows no banners on macOS 26, hence osascript.)
export function notify(title, message, { platform = process.platform, exec = nodeExecFile } = {}) {
  const [cmd, args] = notifyCommand(title, message, platform);
  try { exec(cmd, args, () => {}); } catch {}
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
