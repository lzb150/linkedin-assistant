// check.mjs as a black box. It had no test at all: it imports playwright at
// module scope through lib/browser.mjs, so covering it means replacing that
// module, which `playwright` in makeProject now does. The behaviours pinned
// here are the ones a scheduled run depends on and nothing else could see — the
// exit code launchd reads, and whether seen.json is written back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { makeProject, spawnScript } from "./helpers/e2e.mjs";

const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
const SEEN = { "thread-kept": new Date().toISOString() };

// Launch throws before any page work — enough for the two failure paths.
const throwingPlaywright = (msg) => `
export const chromium = {
  launchPersistentContext: async () => { throw new Error(${JSON.stringify(msg)}); },
};
`;

function project(t, playwright) {
  const p = makeProject(t, { scripts: ["check.mjs", "skills.json"], bins: quiet, playwright });
  writeFileSync(p.path("seen.json"), JSON.stringify(SEEN));
  return p;
}

test("check.mjs: a run that never took the profile lock exits 0 and leaves seen.json alone", async (t) => {
  // The lock is held by a live pid — this process. launchBrowser throws
  // "profile busy" before anything else happens.
  const p = project(t, null);
  mkdirSync(p.path(".browser-profile.lock"), { recursive: true });
  writeFileSync(p.path(".browser-profile.lock", "pid"), String(process.pid));

  const out = await spawnScript(p, "check.mjs").done;   // resolves only on exit 0
  assert.match(out, /Skipped \(profile busy\)/);
  assert.doesNotMatch(out, /^Done\./m, "a skipped run must not claim it was done");
  // The lock holder is mid-run and owns seen.json; writing back the snapshot
  // this process loaded would roll its entries back.
  assert.deepEqual(JSON.parse(readFileSync(p.path("seen.json"), "utf8")), SEEN);
});

test("check.mjs: a run that fails after launch exits 1 so launchd sees the failure", async (t) => {
  const p = project(t, throwingPlaywright("chromium exploded"));
  await assert.rejects(spawnScript(p, "check.mjs").done, /check\.mjs exit 1/);
});

test("check.mjs: a launch failure reports FAILED, not Done", async (t) => {
  const p = project(t, throwingPlaywright("chromium exploded"));
  const run = spawnScript(p, "check.mjs");
  await run.done.catch(() => {});
  await run.output(/FAILED/);
});

// One unread card, opened, read, drafted. The scan loop between "found cards"
// and "wrote a draft" — thread-open verification, bubble extraction, scoring,
// draft writing, badge state — had no test: check-cli only drove the two
// failure exits, so a miswiring of check.mjs to its helpers passed every test.
const scanningPlaywright = (bubbles, { close = "async () => {}" } = {}) => `
const threadUrl = "https://www.linkedin.com/messaging/thread/2-abc/";
let current = "https://www.linkedin.com/messaging/?filter=unread";
const el = (text, attrs = {}) => ({
  innerText: async () => text,
  getAttribute: async (n) => attrs[n] ?? null,
  $: async (sel) => (sel.includes("thread") && attrs.href ? el("", attrs) : null),
  click: async () => { current = threadUrl; },
});
const card = el("", { href: "/messaging/thread/2-abc/" });
card.$ = async (sel) => (sel.includes("participant-names") ? el("Jane Recruiter") : el("", { href: "/messaging/thread/2-abc/" }));
const page = {
  goto: async () => {},
  url: () => current,
  waitForSelector: async () => ({}),
  waitForFunction: async () => ({ jsonValue: async () => "cards" }),
  waitForURL: async () => {},
  waitForTimeout: async () => {},
  $$: async (sel) => (sel.includes("msg-s-event-listitem") ? ${JSON.stringify(bubbles)}.map((t) => el(t)) : [card]),
  $$eval: async () => ["https://www.linkedin.com/messaging/thread/2-abc/"],
  $: async () => el("Jane Recruiter"),
};
export const chromium = {
  launchPersistentContext: async () => ({ pages: () => [page], newPage: async () => page, close: ${close} }),
};
`;

test("check.mjs: an unread thread is opened, scored, drafted, and the badge is written", async (t) => {
  const p = project(t, scanningPlaywright([
    "Hi! We have a Senior Frontend Engineer opening — React, Next.js, TypeScript. Interested in the vacancy?",
  ]));
  const out = await spawnScript(p, "check.mjs").done;

  assert.match(out, /Found 1 conversation cards/);
  assert.match(out, /Unread threads: 1/);
  assert.match(out, /· Jane Recruiter: score=\d+ verdict=relevant/, "the scored line names the participant read off the card");
  assert.match(out, /Done\. Scanned 1 unread, wrote 1 draft\(s\)/);

  const drafts = readdirSync(p.path("drafts"));
  assert.equal(drafts.length, 1, `exactly one draft, got ${drafts.join(", ")}`);
  const md = readFileSync(p.path("drafts", drafts[0]), "utf8");
  assert.match(md, /^thread: Jane Recruiter$/m);
  assert.match(md, /^url: https:\/\/www\.linkedin\.com\/messaging\/thread\/2-abc\/$/m, "the draft records the thread it was opened on, not the inbox url");

  assert.equal(JSON.parse(readFileSync(p.path("notify-state.json"), "utf8")).count, 1, "the badge counts the unread thread");
  assert.equal(Object.keys(JSON.parse(readFileSync(p.path("seen.json"), "utf8"))).length, 2, "the drafted thread joins the pre-seeded one");
});

test("check.mjs: a thread with no job content is skipped without a draft", async (t) => {
  const p = project(t, scanningPlaywright(["Hey, long time! How have you been?"]));
  const out = await spawnScript(p, "check.mjs").done;
  assert.match(out, /not a job message, skipping: Jane Recruiter/);
  assert.match(out, /Done\. Scanned 1 unread, wrote 0 draft\(s\)/);
  assert.deepEqual(readdirSync(p.path("drafts")), [], "nothing drafted");
  assert.equal(JSON.parse(readFileSync(p.path("notify-state.json"), "utf8")).count, 1, "still one unread thread for the badge");
});

test("check.mjs: a quoted weight in the hand-edited skills.json still scores as a number", async (t) => {
  // README says "edit freely". A weight typed as "5" used to concatenate into
  // the score ("6054"), which then passed every threshold as a string.
  const p = project(t, scanningPlaywright([
    "Hi! We have a Senior Frontend Engineer opening — Playwright, TypeScript, CI/CD. Interested in the vacancy?",
  ]));
  const skills = JSON.parse(readFileSync(p.path("skills.json"), "utf8"));
  skills.skills.playwright = "5";
  skills.roles.push(42);
  writeFileSync(p.path("skills.json"), JSON.stringify(skills));

  const out = await spawnScript(p, "check.mjs").done;
  const score = Number(/score=(\d+) verdict=relevant/.exec(out)?.[1]);
  assert.ok(score > 0 && score < 100, `a sane numeric score, got ${score}`);
  assert.match(out, /Done\. Scanned 1 unread, wrote 1 draft\(s\)/);
});

test("check.mjs: a browser that fails to close does not turn a finished run into exit 1", async (t) => {
  const p = project(t, scanningPlaywright(["Hey, long time! How have you been?"], { close: 'async () => { throw new Error("close exploded"); }' }));
  const out = await spawnScript(p, "check.mjs").done;   // exit 0
  assert.match(out, /browser close failed: close exploded/);
  assert.match(out, /Done\. Scanned 1 unread/);
});
