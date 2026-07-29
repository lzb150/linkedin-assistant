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
import { launchBrowser } from "./lib/browser.mjs";

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
    // Djinni sets a `sessionid` cookie even for ANONYMOUS visitors, so cookie
    // presence is NOT a reliable signal (it would auto-detect a "login" before
    // you type anything). The reliable signal is the logged-in nav: a /logout
    // link appears only after a real login, and the /login page itself never
    // shows one.
    async isLoggedIn(page) {
      try {
        if (/\/login/.test(page.url())) return false; // still on the login page
        return await page.$("a[href='/logout']").then(Boolean);
      } catch {}
      return false;
    },
  },
};

const siteKey = process.argv[2] || "linkedin";
const site = SITES[siteKey];
if (!site) {
  console.error(`Unknown site "${siteKey}". Usage: node login.mjs [linkedin|djinni]`);
  process.exit(1);
}
const rerunCmd = `node login.mjs${siteKey === "linkedin" ? "" : ` ${siteKey}`}`;

const ctx = await launchBrowser(join(__dir, site.profile), { headful: true });
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
