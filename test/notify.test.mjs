import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("notifyBanner: darwin with Jobs.app present queues a banner file and pings the daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "banners-"));
  let ensured = 0;
  notifyBanner("Job assistant", "3 new", {
    platform: "darwin",
    app: new URL("./notify.test.mjs", import.meta.url).pathname, // any existing path
    dir, ensure: () => ensured++,
    exec: () => { throw new Error("must not fall back"); },
  });
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), "utf8")), { title: "Job assistant", message: "3 new" });
  assert.equal(ensured, 1);
});

test("notifyBanner: darwin with the app missing falls back to osascript", () => {
  let seen;
  notifyBanner("t", "m", {
    platform: "darwin",
    app: "/nonexistent/Jobs.app",
    exec: (cmd, args, cb) => { seen = cmd; cb(); },
  });
  assert.equal(seen, "osascript");
});
