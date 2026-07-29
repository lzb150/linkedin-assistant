// Shared macOS notification helpers (previously copy-pasted in check.mjs,
// djinni-check.mjs, jobs.mjs and followup.mjs).
import { existsSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const JOBS_APP = join(dirname(fileURLToPath(import.meta.url)), "..", "Jobs.app"); // built by build-jobs.sh

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// macOS banner via osascript; best-effort, never throws.
// (terminal-notifier shows no banners on macOS 26.)
export function notify(title, message) {
  execFile(
    "osascript",
    ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    () => {}
  );
}

// Keep the persistent Jobs.app badge daemon running so it can render the Dock
// badge. `--background` means "badge only, do not open the dashboard"; `-g`
// keeps focus on the user's current app.
// Guard: skip open(1) if Jobs.app is already running — calling open(1) on a
// running app triggers applicationShouldHandleReopen, which opens the dashboard.
export function ensureJobsApp() {
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
