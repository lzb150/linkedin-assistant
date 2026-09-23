// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";

const HEADFUL = process.env.HEADFUL === "1";

// LinkedIn urls that mean "session gone": /login, a 2FA /checkpoint, or the
// /authwall (three inline copies drifted — login.mjs's lacked /authwall).
export const LINKEDIN_LOGGED_OUT = /\/login|\/checkpoint|\/authwall/;
// The profile lock moved to run-lock.mjs (browserless scripts take it too).
// Imported AND re-exported: launchBrowser below calls it, and a bare
// `export … from` would re-export the name without binding it in this scope.
import { acquireProfileLock } from "./run-lock.mjs";
export { acquireProfileLock };

// A Playwright upgrade expects a new browser build (1.60→1.63 moved chromium
// 1223→1243); every browser script then fails at launch. Name the fix in the
// error so the "Browser launch failed" banner is actionable.
export function explainLaunchError(e) {
  const msg = e?.message || "";
  return /Executable doesn't exist/.test(msg)
    ? new Error(`Playwright browser build missing — run: npx playwright install chromium (after every playwright upgrade). ${msg.split("\n")[0]}`)
    : e;
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
        "--disk-cache-size=52428800",   // 50 MB: hourly LinkedIn visits grew .browser-profile/ to 889 MB of cache
        ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
      ],
    });
  } catch (e) {
    release();
    throw explainLaunchError(e);
  }
  const close = ctx.close.bind(ctx);
  ctx.close = async (...a) => { try { return await close(...a); } finally { release(); } };
  return ctx;
}
