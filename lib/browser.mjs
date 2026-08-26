// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";
import { mkdirSync, rmSync, statSync } from "node:fs";

const HEADFUL = process.env.HEADFUL === "1";
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

// Profile lock: two Chromium instances on one persistent profile corrupt it.
// mkdir is atomic, so the dir doubles as the lock; a dir older than 2h is a
// crashed run and is taken over.
export function acquireProfileLock(profileDir, { now = Date.now(), staleMs = STALE_LOCK_MS } = {}) {
  const lock = `${profileDir}.lock`;
  try { if (now - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true }); } catch {}
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`profile busy: another run holds ${lock}`);
    throw e;
  }
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
