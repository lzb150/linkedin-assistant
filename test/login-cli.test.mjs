// login.mjs as a black box, through the fake `playwright` seam. Closing the
// browser window is how a person aborts a manual login, and it makes the poll
// loop's calls reject; unguarded, that printed an unhandled-rejection stack
// instead of the "Nothing saved" line the script promises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, spawnScript } from "./helpers/e2e.mjs";

const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };

// A context whose page rejects the way Playwright does once the window is gone.
const closedMidLogin = `
const closed = () => { throw new Error("Target page, context or browser has been closed"); };
const page = {
  url: () => "https://www.linkedin.com/login",
  goto: async () => {},
  waitForTimeout: async () => closed(),
  $: async () => closed(),
  $$: async () => closed(),
  evaluate: async () => closed(),
  locator: () => ({ first: () => ({ innerText: async () => closed() }) }),
};
export const chromium = {
  launchPersistentContext: async () => ({ pages: () => [page], newPage: async () => page, close: async () => closed() }),
};
`;

test("login.mjs: closing the window prints the documented line, not a rejection stack", async (t) => {
  const p = makeProject(t, { scripts: ["login.mjs"], bins: quiet, playwright: closedMidLogin });
  const run = spawnScript(p, "login.mjs");
  await run.done.catch(() => {});              // exit 1 is the documented outcome
  await run.output(/Browser closed before login completed/);
  await run.output(/Nothing saved\. Re-run:/);
});

test("login.mjs: the abort is an exit 1, and no unhandled rejection is printed", async (t) => {
  const p = makeProject(t, { scripts: ["login.mjs"], bins: quiet, playwright: closedMidLogin });
  const err = await spawnScript(p, "login.mjs").done.then(() => null, (e) => e);
  assert.match(err.message, /login\.mjs exit 1/);
  assert.doesNotMatch(err.message, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
});

// The initial goto sat between the guarded launch and the guarded poll loop —
// the one path in the script that could print a raw unhandled-rejection stack,
// and it leaked the browser context on the way out.
const gotoFails = `
export const chromium = {
  launchPersistentContext: async () => ({
    pages: () => [{ goto: async () => { throw new Error("getaddrinfo ENOTFOUND www.linkedin.com"); } }],
    newPage: async () => ({ goto: async () => { throw new Error("getaddrinfo ENOTFOUND www.linkedin.com"); } }),
    close: async () => { console.log("CTX-CLOSED"); },
  }),
};
`;

test("login.mjs: a network failure opening the login page is a clean message, not a rejection stack", async (t) => {
  const p = makeProject(t, { scripts: ["login.mjs"], bins: quiet, playwright: gotoFails });
  const err = await spawnScript(p, "login.mjs").done.then(() => null, (e) => e);
  assert.ok(err, "a failed login exits non-zero");
  assert.match(err.message, /login\.mjs exit 1/);
  assert.match(err.message, /Could not open https:\/\/www\.linkedin\.com/);
  assert.match(err.message, /ENOTFOUND/, "the underlying cause is named");
  assert.match(err.message, /CTX-CLOSED/, "the browser context is closed, not leaked");
  assert.doesNotMatch(err.message, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
});
