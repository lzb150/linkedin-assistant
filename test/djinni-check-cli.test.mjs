// djinni-check.mjs as a black box, through the fake `playwright` seam. Two
// behaviours that only a whole-script run can show: the exit code launchd reads,
// and the drift guard that stops an empty scrape from wiping the seen store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { makeProject, spawnScript } from "./helpers/e2e.mjs";

const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
const SEEN = ["111", "222"];

// A logged-in Djinni whose unread bucket the evaluate reads as `threads`.
const playwrightWith = (threads, { close = "async () => {}" } = {}) => `
const page = {
  url: () => "https://djinni.co/my/inbox?bucket=unread",
  goto: async () => {},
  waitForTimeout: async () => {},
  $: async (sel) => (sel === "a[href='/logout']" ? {} : null),
  $$: async () => [],
  evaluate: async () => ${JSON.stringify(threads)},
  locator: () => ({ first: () => ({ innerText: async () => "", isVisible: async () => false }) }),
};
export const chromium = {
  launchPersistentContext: async () => ({ pages: () => [page], newPage: async () => page, close: ${close} }),
};
`;
const throwing = `export const chromium = { launchPersistentContext: async () => { throw new Error("boom"); } };`;

function project(t, playwright) {
  const p = makeProject(t, { scripts: ["djinni-check.mjs"], bins: quiet, playwright });
  writeFileSync(p.path("djinni-seen.json"), JSON.stringify(SEEN));
  return p;
}

test("djinni-check.mjs: an empty scrape never wipes the seen store", async (t) => {
  // A selector drift reads as an honest zero. Truncating the file to [] would
  // re-banner every conversation the moment the selector is repaired.
  const p = project(t, playwrightWith([]));
  await spawnScript(p, "djinni-check.mjs").done;
  assert.deepEqual(JSON.parse(readFileSync(p.path("djinni-seen.json"), "utf8")), SEEN);
});

test("djinni-check.mjs: a real scrape does rewrite the seen store", async (t) => {
  const p = project(t, playwrightWith([{ id: "333", label: "Acme" }]));
  await spawnScript(p, "djinni-check.mjs").done;
  assert.deepEqual(JSON.parse(readFileSync(p.path("djinni-seen.json"), "utf8")), ["333"]);
});

test("djinni-check.mjs: a thrown run exits 1", async (t) => {
  const p = project(t, throwing);
  await assert.rejects(spawnScript(p, "djinni-check.mjs").done, /djinni-check\.mjs exit 1/);
});

test("djinni-check.mjs: a browser that fails to close does not turn a finished scan into exit 1", async (t) => {
  const p = project(t, playwrightWith([{ id: "333", label: "Acme" }], { close: 'async () => { throw new Error("close exploded"); }' }));
  const out = await spawnScript(p, "djinni-check.mjs").done;   // exit 0
  assert.match(out, /browser close failed: close exploded/);
  assert.match(out, /Done\. Djinni unread: 1/);
});
