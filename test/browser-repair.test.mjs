import { test } from "node:test";
import assert from "node:assert/strict";
import { launchWithRepair } from "../lib/browser.mjs";

const MISSING = new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chrome-headless-shell\n╔═╗");
const noop = () => {};

test("launchWithRepair returns the context and never installs when launch succeeds", async () => {
  let installs = 0;
  const ctx = await launchWithRepair({ launch: async () => "ctx", install: () => { installs++; }, log: noop });
  assert.equal(ctx, "ctx");
  assert.equal(installs, 0);
});

test("launchWithRepair installs chromium once and relaunches when the build is missing", async () => {
  const calls = [];
  let attempt = 0;
  const ctx = await launchWithRepair({
    launch: async () => { calls.push("launch"); if (attempt++ === 0) throw MISSING; return "ctx"; },
    install: () => { calls.push("install"); },
    log: noop,
  });
  assert.equal(ctx, "ctx");
  assert.deepEqual(calls, ["launch", "install", "launch"]);
});

test("launchWithRepair reports a failed install and does not relaunch", async () => {
  let launches = 0;
  await assert.rejects(
    launchWithRepair({
      launch: async () => { launches++; throw MISSING; },
      install: () => { throw new Error("ENETDOWN"); },
      log: noop,
    }),
    /Playwright browser build missing.*install failed: ENETDOWN/s,
  );
  assert.equal(launches, 1);
});

test("launchWithRepair gives up after one repair when the relaunch still fails", async () => {
  let installs = 0, launches = 0;
  await assert.rejects(
    launchWithRepair({ launch: async () => { launches++; throw MISSING; }, install: () => { installs++; }, log: noop }),
    /Playwright browser build missing — run: npx playwright install chromium/,
  );
  assert.equal(installs, 1);
  assert.equal(launches, 2);
});

test("launchWithRepair rethrows any other launch error without installing", async () => {
  let installs = 0;
  await assert.rejects(
    launchWithRepair({ launch: async () => { throw new Error("profile busy"); }, install: () => { installs++; }, log: noop }),
    /^Error: profile busy$/,
  );
  assert.equal(installs, 0);
});

test("launchWithRepair logs the repair so the run log explains the pause", async () => {
  const lines = [];
  let attempt = 0;
  await launchWithRepair({
    launch: async () => { if (attempt++ === 0) throw MISSING; return "ctx"; },
    install: noop,
    log: (...a) => lines.push(a.join(" ")),
  });
  assert.ok(lines.some((l) => /installing chromium/i.test(l)), lines.join("\n"));
});

test("chromiumInstallCommand points at the installed playwright CLI, not npx", async () => {
  const { chromiumInstallCommand } = await import("../lib/browser.mjs");
  const { existsSync } = await import("node:fs");
  const [bin, cli, ...rest] = chromiumInstallCommand();
  assert.equal(bin, process.execPath);
  assert.match(cli, /node_modules\/playwright\/cli\.js$/);
  assert.ok(existsSync(cli), cli);
  assert.deepEqual(rest, ["install", "chromium"]);
});

test("explainLaunchError is idempotent: an already explained error is returned as is", async () => {
  const { explainLaunchError } = await import("../lib/browser.mjs");
  const once = explainLaunchError(MISSING);
  const twice = explainLaunchError(once);
  assert.equal(twice, once);
  assert.equal(once.message.match(/build missing/g).length, 1);
});
