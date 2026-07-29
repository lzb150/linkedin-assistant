// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
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
