import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyCommand } from "../lib/notify.mjs";

test("notifyCommand: darwin uses osascript with the AppleScript body", () => {
  const [cmd, args] = notifyCommand("Job assistant", "3 new", "darwin");
  assert.equal(cmd, "osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /display notification "3 new" with title "Job assistant"/);
});

test("notifyCommand: win32 calls the toast script with argv params", () => {
  const [cmd, args] = notifyCommand('Strong "match"', "Senior AQA @ Acme", "win32");
  assert.equal(cmd, "powershell");
  assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.match(args[4], /scripts[\\/]windows[\\/]toast\.ps1$/);
  // title/message are separate argv entries — never shell-interpolated
  assert.deepEqual(args.slice(5), ["-Title", 'Strong "match"', "-Message", "Senior AQA @ Acme"]);
});

test("notifyCommand: linux uses notify-send", () => {
  assert.deepEqual(notifyCommand("t", "m", "linux"), ["notify-send", ["t", "m"]]);
});

test("notify passes the built command to exec and never throws", () => {
  let seen;
  notify("t", "m", { platform: "win32", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(new Error("boom")); } });
  assert.equal(seen.cmd, "powershell");
  // synchronously-throwing exec is swallowed too
  notify("t", "m", { platform: "darwin", exec: () => { throw new Error("boom"); } });
});
