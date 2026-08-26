import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "../lib/notify.mjs";

test("notify: linux uses notify-send and never throws", () => {
  let seen;
  notify("t", "m", { platform: "linux", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(new Error("boom")); } });
  assert.deepEqual(seen, { cmd: "notify-send", args: ["t", "m"] });
  notify("t", "m", { platform: "linux", exec: () => { throw new Error("boom"); } });
});

test("notify: darwin with Jobs.app present queues a banner file and pings the daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "banners-"));
  let ensured = 0;
  notify("Job assistant", "3 new", {
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

test("notify: darwin with the app missing falls back to osascript with the AppleScript body", () => {
  let seen;
  notify("Job assistant", "3 new", {
    platform: "darwin", app: "/nonexistent/Jobs.app",
    exec: (cmd, args, cb) => { seen = { cmd, args }; cb(); },
  });
  assert.equal(seen.cmd, "osascript");
  assert.match(seen.args[1], /display notification "3 new" with title "Job assistant"/);
});
