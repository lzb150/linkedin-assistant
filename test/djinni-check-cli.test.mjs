// djinni-check.mjs as a black box, through the fake `playwright` seam. Two
// behaviours that only a whole-script run can show: the exit code launchd reads,
// and the drift guard that stops an empty scrape from wiping the seen store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { makeProject, spawnScript, QUIET_BINS } from "./helpers/e2e.mjs";

const quiet = QUIET_BINS;
const SEEN = ["111", "222"];

// A logged-in Djinni whose unread bucket the evaluate reads as `threads`.
// `emptyBlock`: the page renders Djinni's empty-state block (.threads-empty).
const playwrightWith = (threads, { close = "async () => {}", emptyBlock = false } = {}) => `
const page = {
  url: () => "https://djinni.co/my/inbox?bucket=unread",
  goto: async () => {},
  waitForTimeout: async () => {},
  $: async (sel) => (sel === "a[href='/logout']"${emptyBlock ? ' || sel === ".threads-empty"' : ""} ? {} : null),
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

test("djinni-check.mjs: Djinni's own empty state clears the seen store", async (t) => {
  // A read thread left in the store would never banner again when the
  // recruiter replies in it: freshThreads would call it already known.
  const p = project(t, playwrightWith([], { emptyBlock: true }));
  await spawnScript(p, "djinni-check.mjs").done;
  assert.deepEqual(JSON.parse(readFileSync(p.path("djinni-seen.json"), "utf8")), []);
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

test("djinni-check.mjs: a busy profile is a benign overlap — exit 0, no banner, badge untouched", async (t) => {
  // The lock is held by a live pid (this process), as when `node login.mjs
  // djinni` or a manual run overlaps the hourly agent. check.mjs and
  // closed-check.mjs already treat this as exit 0 with no banner.
  const p = makeProject(t, { scripts: ["djinni-check.mjs"], bins: {}, playwright: playwrightWith([{ id: "1", label: "x" }]) });
  mkdirSync(p.path(".djinni-profile.lock"), { recursive: true });
  writeFileSync(p.path(".djinni-profile.lock", "pid"), String(process.pid));
  const out = await spawnScript(p, "djinni-check.mjs").done;   // resolves only on exit 0
  assert.match(out, /Skipped \(profile busy\)/);
  assert.ok(!existsSync(p.path("notify.log")), "no banner for a busy profile");
  assert.ok(!existsSync(p.path("djinni-notify-state.json")), "badge state not rewritten");
});
