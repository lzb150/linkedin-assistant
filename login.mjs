// ONE-TIME (and whenever the session expires): opens a real browser window.
// YOU log in manually — including 2FA. This script never sees or stores your
// password; it only persists the browser session (cookies) into the site's
// profile directory so the scheduled jobs can reuse it.
//
// It AUTO-DETECTS a successful login (no need to press anything), then saves
// and closes. Times out after ~6 minutes if you don't finish logging in.
//
// Run:  node login.mjs           (LinkedIn)
//       node login.mjs djinni    (Djinni)

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchBrowser, LINKEDIN_LOGGED_OUT } from "./lib/browser.mjs";
import { djinniLoggedIn } from "./lib/djinni-bump.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 6 * 60 * 1000;

const SITES = {
  linkedin: {
    label: "LinkedIn",
    profile: ".browser-profile",
    loginUrl: "https://www.linkedin.com/login",
    nextStep: "node check.mjs",
    // Indicators that we are logged in (any one is enough).
    async isLoggedIn(page, ctx) {
      // Still on /login or a 2FA /checkpoint → not done, whatever the cookies say.
      if (LINKEDIN_LOGGED_OUT.test(page.url())) return false;
      // 1) A LinkedIn auth cookie is present.
      try {
        const cookies = await ctx.cookies("https://www.linkedin.com");
        if (cookies.some((c) => c.name === "li_at" && c.value)) return true;
      } catch {}
      // 2) The logged-in global nav avatar / feed identity module is visible.
      try {
        const el = await page.$("img.global-nav__me-photo, .feed-identity-module, [data-control-name='nav.settings']");
        if (el) return true;
      } catch {}
      return false;
    },
  },
  djinni: {
    label: "Djinni",
    profile: ".djinni-profile",
    loginUrl: "https://djinni.co/login",
    nextStep: "node djinni-check.mjs",
    // Shared with djinni-check.mjs: /logout link present, not on /login (a
    // cookie is NOT a reliable signal — see djinniLoggedIn).
    isLoggedIn: djinniLoggedIn,
  },
};

const siteKey = process.argv[2] || "linkedin";
const site = Object.hasOwn(SITES, siteKey) ? SITES[siteKey] : null;   // "constructor" etc. must not resolve to a prototype member
if (!site) {
  console.error(`Unknown site "${siteKey}". Usage: node login.mjs [linkedin|djinni]`);
  process.exit(1);
}
const rerunCmd = `node login.mjs${siteKey === "linkedin" ? "" : ` ${siteKey}`}`;

let ctx;
try {
  ctx = await launchBrowser(join(__dir, site.profile), { headful: true });
} catch (e) {
  // Typically "profile busy" (a scheduled run holds the lock) — a clean message
  // beats an unhandled-rejection stack trace.
  console.error(e.message);
  process.exit(1);
}
// Inside the guard for the same reason the launch above is: a DNS or network
// failure here is ordinary, and unguarded it printed a raw unhandled-rejection
// stack AND leaked the browser context — the one path between the two guarded
// regions that could do that.
let page;
try {
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });
} catch (e) {
  console.error(`Could not open ${site.loginUrl}: ${e?.message?.split("\n")[0] || e}`);
  await ctx.close().catch(() => {});
  process.exit(1);
}

console.log("\n========================================================");
console.log(" A browser window has opened.");
console.log(` Log in to ${site.label} there (handle 2FA if asked).`);
console.log(" This will detect success automatically and close itself.");
console.log("========================================================\n");

const start = Date.now();
let ok = false;
// Closing the window IS the way to abort a manual login, and it makes both calls
// below reject ("Target page, context or browser has been closed"). Unguarded,
// that surfaced as an unhandled-rejection stack and the documented "Nothing
// saved" line never printed. A closed browser simply ends the wait.
let aborted = false;
while (Date.now() - start < TIMEOUT_MS) {
  try {
    if (await site.isLoggedIn(page, ctx)) { ok = true; break; }
    await page.waitForTimeout(3000);
  } catch (e) {
    aborted = true;
    console.log(`\n✋ Browser closed before login completed (${e?.message?.split("\n")[0] || e}).`);
    break;
  }
}

if (ok) {
  console.log(`✅ Login detected. Saving session to ${site.profile} ...`);
  // Both calls are guarded for the same reason the failure path below is: the
  // user closing the window is how a manual login ends, and doing it inside
  // this two-second flush made waitForTimeout/close reject — an unhandled
  // rejection stack instead of the line that says the session was saved. The
  // cookies are already on disk by then; the wait is only a courtesy.
  await page.waitForTimeout(2000).catch(() => {});
  await ctx.close().catch(() => {});
  console.log(`✅ Done. You can now run:  ${site.nextStep}`);
  process.exit(0);
} else {
  console.log(`${aborted ? "Nothing saved." : "⌛ Timed out waiting for login. Nothing saved."} Re-run: ${rerunCmd}`);
  await ctx.close().catch(() => {});   // already closed on the abort path
  process.exit(1);
}
