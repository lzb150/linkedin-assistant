// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADFUL = process.env.HEADFUL === "1";
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

// Is the pid recorded in the lock dir still running? Missing/unreadable pid
// file → unknown (null), so the caller falls back to the mtime heuristic.
function lockPidAlive(lock) {
  let pid;
  try { pid = Number(readFileSync(join(lock, "pid"), "utf8")); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

// Profile lock: two Chromium instances on one persistent profile corrupt it.
// mkdir is atomic, so the dir doubles as the lock. The holder's pid is written
// inside: a dead pid means a crashed run and is taken over immediately; only
// when the pid is unknown do we fall back to "older than 2h is stale".
export function acquireProfileLock(profileDir, { now = Date.now(), staleMs = STALE_LOCK_MS } = {}) {
  const lock = `${profileDir}.lock`;
  try {
    const alive = lockPidAlive(lock);
    const stale = alive === null ? now - statSync(lock).mtimeMs > staleMs : !alive;
    if (stale) rmSync(lock, { recursive: true, force: true });
  } catch {}
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`profile busy: another run holds ${lock}`);
    throw e;
  }
  try { writeFileSync(join(lock, "pid"), String(process.pid)); } catch {}
  const release = () => { rmSync(lock, { recursive: true, force: true }); process.off("exit", release); };
  process.on("exit", release);
  return release;
}

// Visible browser when headful (login scripts always; scheduled jobs with
// HEADFUL=1), headless "new" mode otherwise.
export async function launchBrowser(profileDir, { headful = HEADFUL } = {}) {
  const release = acquireProfileLock(profileDir);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: !headful,
      viewport: { width: 1280, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
      ],
    });
  } catch (e) { release(); throw e; }
  const close = ctx.close.bind(ctx);
  ctx.close = async (...a) => { try { return await close(...a); } finally { release(); } };
  return ctx;
}
