// runScan is the skeleton check.mjs and djinni-check.mjs share; driven here
// through its `launch` seam with a fake browser context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScan } from "../lib/scan-run.mjs";
import { closeBounded } from "../lib/browser.mjs";

const fakeCtx = (close = async () => {}) => ({ pages: () => [{}], newPage: async () => ({}), close });
const quiet = { app: "test", profile: "/nowhere", alert: () => {} };   // never a real banner from a test

test("runScan: a scan that never settles fails at the deadline, still finishes and closes", async () => {
  const calls = [];
  const outcome = await runScan({
    ...quiet,
    launch: async () => fakeCtx(async () => calls.push("close")),
    scan: () => new Promise(() => {}),   // a hung renderer
    finish: ({ held }) => calls.push(`finish:${held}`),
    alert: (_app, msg) => calls.push(`alert:${msg.split(":")[0]}`),
    deadlineMs: 50,
  });
  assert.equal(outcome, "failed");
  assert.deepEqual(calls, ["alert:Run stuck", "finish:true", "close"]);
});

test("runScan: a normal scan is ok; a busy profile is busy, not failed", async () => {
  assert.equal(await runScan({ ...quiet, launch: async () => fakeCtx(), scan: async () => {}, deadlineMs: 1000 }), "ok");
  assert.equal(await runScan({ ...quiet, launch: async () => { throw new Error("profile busy (pid 1)"); }, scan: async () => {} }), "busy");
});

test("closeBounded: a close that never settles gives up at the budget; a rejected one is logged", async () => {
  const lines = [];
  const log = (...a) => lines.push(a.join(" "));
  const t0 = Date.now();
  await closeBounded({ close: () => new Promise(() => {}) }, { log, budgetMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  await closeBounded({ close: async () => { throw new Error("gone"); } }, { log, budgetMs: 50 });
  await closeBounded(undefined, { log });
  assert.deepEqual(lines, ["browser close timed out", "browser close failed: gone"]);
});
