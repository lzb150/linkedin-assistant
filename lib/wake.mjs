// Is this Mac in a DarkWake on battery right now?
//
// launchd fires a schedule the Mac slept through inside the next DarkWake — a
// 5–10 s background wake with no display — and on battery `caffeinate -s` does
// not hold the system up, so it sleeps again under the run. The browserless
// sources fit in that window; LinkedIn's feed does not, and every such run
// logged `page.goto: Timeout 30000ms` and a LinkedIn count of 0. jobs.mjs asks
// this before launching the browser and defers LinkedIn instead.
//
//   pmset -g systemstate  "Current System Capabilities are: CPU Graphics Audio Network"
//                         (a DarkWake lists no Graphics)
//   pmset -g batt         "Now drawing from 'AC Power'" | "'Battery Power'"
//
// On AC power caffeinate -s keeps the Mac awake for the whole run, so a
// DarkWake there is not a reason to skip. Anything unreadable (no pmset: Linux
// CI, an unexpected format) answers false — never skip on a guess.
import { execFileSync } from "node:child_process";

export function parseDarkWake(systemstate) {
  const m = /Current System Capabilities are:([^\n]*)/.exec(String(systemstate ?? ""));
  return Boolean(m) && !/\bGraphics\b/.test(m[1]);
}

export const parseOnAC = (batt) => /Now drawing from 'AC Power'/.test(String(batt ?? ""));

const pmset = (arg) => execFileSync("pmset", ["-g", arg], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

export function darkWakeOnBattery(run = pmset) {
  try {
    return parseDarkWake(run("systemstate")) && !parseOnAC(run("batt"));
  } catch {
    return false;
  }
}
