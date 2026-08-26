import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyBanner, notifyCommand } from "../lib/notify.mjs";

test("notifyCommand: darwin uses osascript with the AppleScript body", () => {
  const [cmd, args] = notifyCommand("Job assistant", "3 new", "darwin");
  assert.equal(cmd, "osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /display notification "3 new" with title "Job assistant"/);
});

test("notifyCommand: linux uses notify-send", () => {
  assert.deepEqual(notifyCommand("t", "m", "linux"), ["notify-send", ["t", "m"]]);
});

test("notify passes the built command to exec and never throws", () => {
  let seen;
  notify("t", "m", { platform: "linux", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(new Error("boom")); } });
  assert.equal(seen.cmd, "notify-send");
  // synchronously-throwing exec is swallowed too
  notify("t", "m", { platform: "darwin", exec: () => { throw new Error("boom"); } });
});

test("notifyBanner: non-darwin falls back to notify (exec sees the platform command)", () => {
  let seen;
  notifyBanner("t", "m", { platform: "linux", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(); } });
  assert.deepEqual(seen, { cmd: "notify-send", args: ["t", "m"] });
});

test("notifyBanner: darwin with the app present launches it via open(1)", () => {
  let seen;
  const fakeChild = { on: () => {}, unref: () => {} };
  notifyBanner("Job assistant", "3 new", {
    platform: "darwin",
    app: new URL("./notify.test.mjs", import.meta.url).pathname, // any existing path
    spawnFn: (cmd, args) => { seen = { cmd, args }; return fakeChild; },
    queueFn: () => false, // Jobs.app not running (it would take precedence)
  });
  assert.equal(seen.cmd, "open");
  assert.deepEqual(seen.args.slice(-2), ["Job assistant", "3 new"]);
});

test("notifyBanner: prefers the Jobs.app queue when it accepts the banner", () => {
  let spawned = false, queued;
  notifyBanner("Job assistant", "3 new", {
    platform: "darwin",
    app: new URL("./notify.test.mjs", import.meta.url).pathname,
    spawnFn: () => { spawned = true; return { on: () => {}, unref: () => {} }; },
    queueFn: (title, body) => { queued = { title, body }; return true; },
  });
  assert.deepEqual(queued, { title: "Job assistant", body: "3 new" });
  assert.equal(spawned, false, "the queue path must not also spawn Notifier.app");
});

test("notifyBanner: darwin with the app missing falls back to osascript", () => {
  let seen;
  notifyBanner("t", "m", {
    platform: "darwin",
    app: "/nonexistent/Notifier.app",
    exec: (cmd, args, cb) => { seen = cmd; cb(); },
    spawnFn: () => { throw new Error("must not spawn"); },
    queueFn: () => false, // Jobs.app not running (it would take precedence)
  });
  assert.equal(seen, "osascript");
});
