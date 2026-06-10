// ONE-TIME (and whenever the session expires): opens a real browser window.
// YOU log in to Djinni manually — including 2FA. This script never sees or
// stores your password; it only persists the browser session (cookies) into
// ./.djinni-profile so the scheduled check can reuse it.
//
// It AUTO-DETECTS a successful login (no need to press anything), then saves
// and closes. Times out after ~6 minutes if you don't finish logging in.
//
// Run:  node djinni-login.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".djinni-profile");
const TIMEOUT_MS = 6 * 60 * 1000;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://djinni.co/login", { waitUntil: "domcontentloaded" });

console.log("\n========================================================");
console.log(" A browser window has opened.");
console.log(" Log in to Djinni there (handle 2FA if asked).");
console.log(" This will detect success automatically and close itself.");
console.log("========================================================\n");

// Are we logged in? Djinni sets a `sessionid` cookie even for ANONYMOUS
// visitors, so cookie presence is NOT a reliable signal (it would auto-detect a
// "login" before you type anything). The reliable signal is the logged-in nav:
// a /logout link appears only after a real login, and the /login page itself
// never shows one.
async function isLoggedIn() {
  try {
    if (/\/login/.test(page.url())) return false; // still on the login page
    return await page.$("a[href='/logout']").then(Boolean);
  } catch {}
  return false;
}

const start = Date.now();
let ok = false;
while (Date.now() - start < TIMEOUT_MS) {
  if (await isLoggedIn()) { ok = true; break; }
  await page.waitForTimeout(3000);
}

if (ok) {
  console.log("✅ Login detected. Saving session to .djinni-profile ...");
  // Give the persistent context a moment to flush cookies to disk.
  await page.waitForTimeout(2000);
  await ctx.close();
  console.log("✅ Done. You can now run:  node djinni-check.mjs");
  process.exit(0);
} else {
  console.log("⌛ Timed out waiting for login. Nothing saved. Re-run: node djinni-login.mjs");
  await ctx.close();
  process.exit(1);
}
