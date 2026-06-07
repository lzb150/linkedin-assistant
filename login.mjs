// ONE-TIME (and whenever the session expires): opens a real browser window.
// YOU log in to LinkedIn manually — including 2FA. This script never sees or
// stores your password; it only persists the browser session (cookies) into
// ./.browser-profile so the scheduled check can reuse it.
//
// It AUTO-DETECTS a successful login (no need to press anything), then saves
// and closes. Times out after ~6 minutes if you don't finish logging in.
//
// Run:  node login.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(__dir, ".browser-profile");
const TIMEOUT_MS = 6 * 60 * 1000;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

console.log("\n========================================================");
console.log(" A browser window has opened.");
console.log(" Log in to LinkedIn there (handle 2FA if asked).");
console.log(" This will detect success automatically and close itself.");
console.log("========================================================\n");

// Indicators that we are logged in (any one is enough).
async function isLoggedIn() {
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
}

const start = Date.now();
let ok = false;
while (Date.now() - start < TIMEOUT_MS) {
  if (await isLoggedIn()) { ok = true; break; }
  await page.waitForTimeout(3000);
}

if (ok) {
  console.log("✅ Login detected. Saving session to .browser-profile ...");
  // Give the persistent context a moment to flush cookies to disk.
  await page.waitForTimeout(2000);
  await ctx.close();
  console.log("✅ Done. You can now run:  node check.mjs");
  process.exit(0);
} else {
  console.log("⌛ Timed out waiting for login. Nothing saved. Re-run: node login.mjs");
  await ctx.close();
  process.exit(1);
}
