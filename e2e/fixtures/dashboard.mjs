// Playwright fixtures for the dashboard suite. Every test gets its own state
// server (createServer on a random loopback port, fresh job-state.json in a
// temp dir) over a dashboard built once by global-setup.mjs, and a browser
// context that cannot leave the machine. Never the live :7777 server, never
// the repo's job-state.json or applications/.
import { test as base, expect } from "@playwright/test";
import { startServer, BUILDS_ENV } from "../support/dashboard-server.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";
import { DashboardPage, titlePattern } from "../pages/dashboard-page.mjs";

// The job links point at a host that does not exist; a popup opened by
// "Open job" lands on this stub instead of the network.
const JOB_STUB = "<!doctype html><title>Job posting (stub)</title><h1>Job posting</h1>";

export const test = base.extend({
  // Which global-setup build to serve: "full" (jobs.mjs) or "empty" (no packages).
  dataset: ["full", { option: true }],
  // job-state.json the server starts with.
  seedState: [DEFAULT_STATE, { option: true }],

  server: async ({ dataset, seedState }, use) => {
    const builds = JSON.parse(process.env[BUILDS_ENV] || "null");
    if (!builds?.[dataset]) throw new Error(`no "${dataset}" dashboard build: run the suite via playwright.config.mjs (its globalSetup builds them)`);
    const server = await startServer({ indexPath: builds[dataset], state: seedState });
    await use(server);
    await server.remove();
  },

  // Only this test's own server. Everything else (Google Fonts, the fixture
  // job hosts, any other 127.0.0.1 port such as the live :7777) never leaves
  // the browser: fonts are aborted (the page falls back to system fonts), a
  // page load gets the stub.
  context: async ({ context, server }, use) => {
    await context.route((url) => url.origin !== server.base, (route) =>
      route.request().resourceType() === "document"
        ? route.fulfill({ contentType: "text/html", body: JOB_STUB })
        : route.abort());
    await use(context);
  },

  dashboard: async ({ page, server }, use) => {
    const dashboard = new DashboardPage(page, server.base);
    await dashboard.goto();
    await use(dashboard);
  },
});

export { expect };

// Expected on-screen card headings, in page order, for toHaveText():
// cardsTitled("acme", "globex") → [/^Senior QA Automation Engineer/, /^SDET/].
export const cardsTitled = (...keys) => keys.map((k) => titlePattern(JOBS[k].title));
