// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
  if (msg.startsWith("Playwright browser build missing")) return e;   // already explained (launchWithRepair → launchBrowser)
  return /Executable doesn't exist/.test(msg)
    ? new Error(`Playwright browser build missing — run: npx playwright install chromium (after every playwright upgrade). ${msg.split("\n")[0]}`)
    : e;
}

const BUILD_MISSING = /Executable doesn't exist/;

// The build also vanishes without an upgrade: on 2026-09-24 something wiped
// ~/Library/Caches/ms-playwright and every hourly browser run failed for a day
// while the "Browser launch failed" banner went unnoticed. Run the install
// ourselves — once per process — and relaunch. The install is the package's
// own CLI (no npx, so no registry round-trip); 5 minutes covers ~100 MB on a
// slow link. A failed install names itself in the error; the banner is the same.
// The package does not export ./cli.js, so resolve its entry and step over.
export function chromiumInstallCommand() {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright")), "cli.js");
  return [process.execPath, cli, "install", "chromium"];
}

export function installChromium() {
  const [bin, ...args] = chromiumInstallCommand();
  execFileSync(bin, args, { stdio: "inherit", timeout: 5 * 60_000 });
}

// launch() and install() are injected so tests can drive the repair path
// without a real browser or a 100 MB download.
export async function launchWithRepair({ launch, install = installChromium, log = console.log }) {
  try {
    return await launch();
  } catch (e) {
    if (!BUILD_MISSING.test(e?.message || "")) throw e;
    log("browser: Playwright build missing — installing chromium…");
    try {
      install();
    } catch (ie) {
      throw explainLaunchError(new Error(`${e.message.split("\n")[0]} (install failed: ${ie?.message || ie})`));
    }
    try {
      return await launch();
    } catch (e2) {
      throw explainLaunchError(e2);
    }
  }
}

// Visible browser when headful (login scripts always; scheduled jobs with
// HEADFUL=1), headless "new" mode otherwise.
export async function launchBrowser(profileDir, { headful = HEADFUL } = {}) {
  const release = acquireProfileLock(profileDir);
  const launch = () => chromium.launchPersistentContext(profileDir, {
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disk-cache-size=52428800",   // 50 MB: hourly LinkedIn visits grew .browser-profile/ to 889 MB of cache
      ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
    ],
  });
  let ctx;
  try {
    ctx = await launchWithRepair({ launch });
  } catch (e) {
    release();
    throw explainLaunchError(e);
  }
  const close = ctx.close.bind(ctx);
  ctx.close = async (...a) => { try { return await close(...a); } finally { release(); } };
  return ctx;
}
