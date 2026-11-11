// End-to-end tests of the jobs dashboard in a real browser: npm run test:e2e.
// Kept out of test/ on purpose: bare `node --test` runs every file there.
// Each test serves a fixture build through its own state server on a random
// loopback port (e2e/fixtures/dashboard.mjs) — never the live :7777 instance.
// First run on a machine: npx playwright install chromium
// CI runs it in the e2e job of .github/workflows/test.yml (Ubuntu, Node 20 + 24).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // The Dark toggle starts from the system preference: pin it.
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
