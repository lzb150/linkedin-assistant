# Browser Helper Extraction + Login Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the copy-pasted Playwright launch block into `lib/browser.mjs` and merge `login.mjs` + `djinni-login.mjs` into one parameterized script.

**Architecture:** A single `launchBrowser(profileDir, {headful})` helper wraps `chromium.launchPersistentContext` with the shared viewport/anti-automation args; the merged `login.mjs` selects a site config (`linkedin` default, `djinni`) from an internal table that keeps each site's login-detection logic verbatim.

**Tech Stack:** Node.js ESM (`.mjs`), Playwright (already installed — the repo's only dependency), `node --test` for the existing suite.

**Spec:** `docs/superpowers/specs/2026-07-29-browser-helper-login-merge-design.md`

## Global Constraints

- No behavior change: scheduled jobs run headless unless `HEADFUL=1`; login scripts always open a visible window.
- No new dependencies.
- All docs/comments in English.
- Existing suite must stay green: `node --test` from the repo root.
- Preserve existing comments when moving code (especially the Djinni `sessionid`-cookie caveat and the anti-automation args rationale).

---

### Task 1: `lib/browser.mjs` + migrate the three scheduled scripts

**Files:**
- Create: `lib/browser.mjs`
- Modify: `check.mjs:12,26,68-75` (import, HEADFUL const, launch block)
- Modify: `jobs.mjs:34,107-116` (HEADFUL const, lazy playwright import + launch block)
- Modify: `djinni-check.mjs:11,25,32-39` (import, HEADFUL const, launch block)

**Interfaces:**
- Produces: `launchBrowser(profileDir: string, opts?: { headful?: boolean }) → Promise<BrowserContext>` — exported from `lib/browser.mjs`. `headful` defaults to `process.env.HEADFUL === "1"`. Task 2 relies on this exact signature.

There is no unit test for the launcher: it is a trivial wrapper around Playwright (no logic beyond the args ternary), and the login/check scripts are interactive. Verification is a real headless launch smoke plus the existing suite.

- [ ] **Step 1: Create `lib/browser.mjs`**

```js
// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, login.mjs and djinni-login.mjs).
import { chromium } from "playwright";

const HEADFUL = process.env.HEADFUL === "1";

// Visible browser when headful (login scripts always; scheduled jobs with
// HEADFUL=1), headless "new" mode otherwise.
export function launchBrowser(profileDir, { headful = HEADFUL } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
    ],
  });
}
```

- [ ] **Step 2: Smoke-test the helper with a real headless launch**

Run (from the repo root):
```bash
node -e 'const { launchBrowser } = await import("./lib/browser.mjs"); const ctx = await launchBrowser("/tmp/browser-smoke-profile"); console.log("launched ok, pages:", ctx.pages().length); await ctx.close();' && rm -rf /tmp/browser-smoke-profile
```
Expected: prints `launched ok, pages: 1` (or `0`), exits 0, no window appears.

- [ ] **Step 3: Migrate `check.mjs`**

Replace the playwright import (line 12) — keep the other imports untouched:
```js
// BEFORE
import { chromium } from "playwright";
// AFTER
import { launchBrowser } from "./lib/browser.mjs";
```

Delete line 26 (`const HEADFUL = process.env.HEADFUL === "1";`) — it was only used by the launch block. Keep `MAX` and `SCAN_ALL`.

Replace the launch block (lines 68–75):
```js
// BEFORE
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !HEADFUL,
  viewport: { width: 1280, height: 900 },
  args: [
    "--disable-blink-features=AutomationControlled",
    ...(HEADFUL ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
  ],
});
// AFTER
const ctx = await launchBrowser(PROFILE);
```

- [ ] **Step 4: Migrate `djinni-check.mjs`**

Same three edits as Step 3, at their locations in this file: the `import { chromium } from "playwright";` line (11) becomes `import { launchBrowser } from "./lib/browser.mjs";`, the `const HEADFUL = ...` line (25) is deleted, and the launch block (lines 32–39, identical to the one above with its own `PROFILE`) becomes `const ctx = await launchBrowser(PROFILE);`.

- [ ] **Step 5: Migrate `jobs.mjs`**

Delete line 34 (`const HEADFUL = process.env.HEADFUL === "1";`) — only the launch block used it. Keep `DOU_ONLY`.

Add to the existing `./lib/` import group at the top (after line 26, `import { log, notify as osaNotify } from "./lib/notify.mjs";`):
```js
import { launchBrowser } from "./lib/browser.mjs";
```

Replace the lazy import + launch inside the LinkedIn branch (lines 108–116):
```js
// BEFORE
  const { chromium } = await import("playwright");
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !HEADFUL,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(HEADFUL ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
    ],
  });
// AFTER
  const ctx = await launchBrowser(PROFILE);
```
(The lazy `import("playwright")` is intentionally dropped per the spec: playwright is an unconditional dependency and module-load cost is negligible.)

- [ ] **Step 6: Verify syntax + suite**

Run:
```bash
node --check check.mjs && node --check djinni-check.mjs && node --check jobs.mjs && node --check lib/browser.mjs && node --test
```
Expected: all `--check` silent (exit 0), all existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/browser.mjs check.mjs djinni-check.mjs jobs.mjs
git commit -m "refactor: extract shared Playwright launcher into lib/browser.mjs"
```

---

### Task 2: Merge login scripts + update references

**Files:**
- Modify: `login.mjs` (full rewrite below)
- Delete: `djinni-login.mjs`
- Modify: `djinni-check.mjs:1,58-59` (references to djinni-login.mjs)
- Modify: `README.md:98,250-251,271,273` (references)

**Interfaces:**
- Consumes: `launchBrowser(profileDir, { headful: true })` from Task 1.
- Produces: CLI contract `node login.mjs [linkedin|djinni]`, default `linkedin` (keeps `npm run login` and all existing `node login.mjs` mentions working). Unknown site → usage on stderr, exit 1.

- [ ] **Step 1: Rewrite `login.mjs`**

Full new content (login-detection logic and its comments are moved verbatim from the two old scripts):

```js
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
```

- [ ] **Step 2: Verify the unknown-site guard (the only non-interactive path)**

Run:
```bash
node --check login.mjs && node login.mjs nosuchsite; echo "exit=$?"
```
Expected: `--check` silent; then `Unknown site "nosuchsite". Usage: node login.mjs [linkedin|djinni]` on stderr and `exit=1`. No browser window opens.

- [ ] **Step 3: Delete `djinni-login.mjs`**

```bash
git rm djinni-login.mjs
```

- [ ] **Step 4: Update `djinni-check.mjs` references**

Line 1, header comment:
```js
// BEFORE
// The scheduled Djinni job. Reuses the session saved by djinni-login.mjs and
// AFTER
// The scheduled Djinni job. Reuses the session saved by `node login.mjs djinni` and
```

Lines 58–59, session-expired path:
```js
// BEFORE
    log("❌ Not logged in (session expired). Run:  node djinni-login.mjs");
    notify("Djinni assistant", "Session expired — run `node djinni-login.mjs` to re-authenticate.");
// AFTER
    log("❌ Not logged in (session expired). Run:  node login.mjs djinni");
    notify("Djinni assistant", "Session expired — run `node login.mjs djinni` to re-authenticate.");
```

- [ ] **Step 5: Update `README.md` references**

Line 98 (Djinni one-time login code block):
```
// BEFORE
node djinni-login.mjs   # opens a browser; log in to Djinni manually (incl. 2FA)
// AFTER
node login.mjs djinni   # opens a browser; log in to Djinni manually (incl. 2FA)
```

Lines 250–251 (file tree) — merge into one line:
```
// BEFORE
├── login.mjs          one-time LinkedIn login
├── djinni-login.mjs   one-time Djinni login
// AFTER
├── login.mjs          one-time login (LinkedIn by default, `djinni` argument)
```

Line 271 ("What's where" table, `login.mjs` row):
```
// BEFORE
| `login.mjs`           | One-time manual login; persists session.                  |
// AFTER
| `login.mjs`           | One-time manual login (LinkedIn default, `node login.mjs djinni`); persists session. |
```

Line 273 — delete the `djinni-login.mjs` table row entirely:
```
| `djinni-login.mjs`    | One-time manual Djinni login; persists session.           |
```

- [ ] **Step 6: Verify no stale references + suite green**

Run:
```bash
grep -rn "djinni-login" --include='*.mjs' --include='*.sh' --include='*.md' --include='*.json' --include='*.swift' --include='*.plist' . | grep -v node_modules | grep -v docs/superpowers; node --test
```
Expected: grep prints nothing (specs/plans under docs/superpowers are historical and exempt); all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add login.mjs djinni-check.mjs README.md
git commit -m "refactor: merge djinni-login.mjs into login.mjs with a site argument"
```
