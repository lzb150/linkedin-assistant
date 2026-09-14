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
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });

console.log("\n========================================================");
console.log(" A browser window has opened.");
console.log(` Log in to ${site.label} there (handle 2FA if asked).`);
console.log(" This will detect success automatically and close itself.");
console.log("========================================================\n");

const start = Date.now();
let ok = false;
while (Date.now() - start < TIMEOUT_MS) {
  if (await site.isLoggedIn(page, ctx)) { ok = true; break; }
  await page.waitForTimeout(3000);
}

if (ok) {
  console.log(`✅ Login detected. Saving session to ${site.profile} ...`);
  // Give the persistent context a moment to flush cookies to disk.
  await page.waitForTimeout(2000);
  await ctx.close();
  console.log(`✅ Done. You can now run:  ${site.nextStep}`);
  process.exit(0);
} else {
  console.log(`⌛ Timed out waiting for login. Nothing saved. Re-run: ${rerunCmd}`);
  await ctx.close();
  process.exit(1);
}
