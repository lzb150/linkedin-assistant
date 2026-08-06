import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyCommand } from "../lib/notify.mjs";

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
