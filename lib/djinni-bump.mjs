// "Bump My Profile" automation. Djinni allows one bump per 30 days (the button
// on /my/profile/ is disabled while the cooldown runs). djinni-check.mjs calls
// this after its hourly unread scan, reusing the same logged-in page.
//
// State file (djinni-bump-state.json): { lastBumpAt, nextCheckAt }.
// nextCheckAt throttles /my/profile/ visits to ~one per day.
import { readFileSync } from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1000;

export function readBumpState(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      lastBumpAt: typeof raw.lastBumpAt === "string" ? raw.lastBumpAt : "",
      nextCheckAt: typeof raw.nextCheckAt === "string" ? raw.nextCheckAt : "",
    };
  } catch {
    return { lastBumpAt: "", nextCheckAt: "" };
  }
}

// Time to visit /my/profile/ at all? Missing or garbage nextCheckAt -> yes.
export function dueForCheck(state, now = Date.now()) {
  const t = Date.parse(state.nextCheckAt);
  return !Number.isFinite(t) || now >= t;
}

// State transition for a check outcome: always look again in a day. No
// hardcoded cooldown — the button's own enabled/disabled state is the source
// of truth, so whatever bump frequency Djinni allows (it can differ by plan
// or search mode), the next enabled button gets clicked within a day.
export function nextBumpState(prev, outcome, now = Date.now()) {
  return {
    lastBumpAt: outcome === "bumped" ? new Date(now).toISOString() : prev.lastBumpAt,
    nextCheckAt: new Date(now + DAY_MS).toISOString(),
  };
}

// Click the bump button and confirm its modal. Assumes a logged-in page.
// Returns "bumped" | "cooldown" | "unverified".
export async function bumpProfile(page) {
  await page.goto("https://djinni.co/my/profile/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const btn = page.locator("button.js-open-reactivate-modal-btn").first();
  if (!(await btn.count())) return "unverified"; // markup changed — needs a human look
  if (await btn.isDisabled()) return "cooldown";
  await btn.click();
  // The class name says the button opens a confirmation modal. The modal is
  // unreachable while on cooldown, so its selector could not be verified live:
  // try the usual Bootstrap shapes, and if none shows up assume the click
  // alone did the bump — the disabled-state re-check below is the real verdict.
  const confirm = page
    .locator(".modal.show button[type=submit], .modal.show .btn-primary, .modal.show form button")
    .first();
  try {
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await confirm.click();
  } catch {}
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  const after = page.locator("button.js-open-reactivate-modal-btn").first();
  // Disabled after the click means Djinni registered the bump.
  return (await after.count()) && (await after.isDisabled()) ? "bumped" : "unverified";
}
