// "Bump My Profile" automation. Djinni allows one bump per 7 days (observed live 2026-09-08: bumped
// 1 Sep, button enabled again 8 Sep; its docs used to say 30). The button
// on /my/profile/ is disabled while the cooldown runs). djinni-check.mjs calls
// this after its hourly unread scan, reusing the same logged-in page.
//
// State file (djinni-bump-state.json): { lastBumpAt, nextCheckAt }.
// nextCheckAt throttles /my/profile/ visits to ~one per day.
import { readJson } from "./json-file.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Expected cooldown (observed 7 days). Used ONLY to decide how often to look:
// the button's enabled/disabled state stays the source of truth.
const COOLDOWN_DAYS = 7;

export function readBumpState(path) {
  const raw = readJson(path, null) || {};
  return {
    lastBumpAt: typeof raw.lastBumpAt === "string" ? raw.lastBumpAt : "",
    nextCheckAt: typeof raw.nextCheckAt === "string" ? raw.nextCheckAt : "",
  };
}

// Time to visit /my/profile/ at all? Missing or garbage nextCheckAt -> yes.
export function dueForCheck(state, now = Date.now()) {
  const t = Date.parse(state.nextCheckAt);
  return !Number.isFinite(t) || now >= t;
}

// State transition for a check outcome. Normally look again in a day; while
// the cooldown is about to end (from one day before the expected end until one
// day after it) a "cooldown" answer is re-checked hourly, so the bump lands
// within an hour of the button coming back instead of up to a day later. Past
// that window (Djinni changed the rule?) it falls back to daily — never hourly
// forever. lastBumpAt unknown → daily.
export function nextBumpState(prev, outcome, now = Date.now()) {
  const lastBumpAt = outcome === "bumped" ? new Date(now).toISOString() : prev.lastBumpAt;
  let wait = DAY_MS;
  if (outcome === "cooldown") {
    const last = Date.parse(prev.lastBumpAt);
    const expectedEnd = last + COOLDOWN_DAYS * DAY_MS;
    if (Number.isFinite(last) && now >= expectedEnd - DAY_MS && now <= expectedEnd + DAY_MS) wait = HOUR_MS;
  }
  return { lastBumpAt, nextCheckAt: new Date(now + wait).toISOString() };
}

// Click the bump button and confirm its modal. Assumes a logged-in page.
// Returns "bumped" | "cooldown" | "unverified".
export async function bumpProfile(page) {
  await page.goto("https://djinni.co/my/profile/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const btn = page.locator("button.js-open-reactivate-modal-btn").first();
  if (!(await btn.count())) return "unverified"; // markup changed — needs a human look
  if (await btn.isDisabled()) return "cooldown";
  // Scope the confirm click to the modal THIS button targets (Bootstrap
  // data-bs-target / data-target), falling back to the first shown modal — and
  // only if that modal is about bumping. An unrelated modal open at load
  // (announcement, survey) must never get its first button pressed.
  const target = (await btn.getAttribute("data-bs-target")) || (await btn.getAttribute("data-target"));
  await btn.click();
  // The modal is unreachable while on cooldown, so its selector could not be
  // verified live: try the usual Bootstrap shapes, and if none shows up assume
  // the click alone did the bump — the disabled-state re-check below is the real verdict.
  const modal = (target && /^#[\w-]+$/.test(target) ? page.locator(target) : page.locator(".modal.show")).first();
  try {
    await modal.waitFor({ state: "visible", timeout: 5000 });
    if (!/bump|підня|подня|reactivat/i.test(await modal.innerText())) return "unverified";   // some other modal — never press its button
    await modal.locator("button[type=submit], .btn-primary, form button").first().click();
  } catch {}
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  const after = page.locator("button.js-open-reactivate-modal-btn").first();
  // Disabled after the click means Djinni registered the bump.
  return (await after.count()) && (await after.isDisabled()) ? "bumped" : "unverified";
}
