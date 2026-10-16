import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "../lib/notify.mjs";

// Every call below stubs the Telegram copy: the real one reads this checkout's
// telegram.json and would post to the owner's phone.
const noPhone = () => {};

test("notify: linux uses notify-send and never throws", () => {
  let seen;
  notify("t", "m", { telegram: noPhone, platform: "linux", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(new Error("boom")); } });
  assert.deepEqual(seen, { cmd: "notify-send", args: ["--", "t", "m"] }, "-- so a message starting with '-' is not parsed as an option");
  notify("t", "m", { telegram: noPhone, platform: "linux", exec: () => { throw new Error("boom"); } });
});

test("notify: darwin with Jobs.app present queues a banner file and pings the daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "banners-"));
  let ensured = 0;
  notify("Job assistant", "3 new", {
    telegram: noPhone,
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
    telegram: noPhone,
    platform: "darwin", app: "/nonexistent/Jobs.app",
    exec: (cmd, args, cb) => { seen = { cmd, args }; cb(); },
  });
  assert.equal(seen.cmd, "osascript");
  assert.deepEqual(seen.args.slice(-2), ["3 new", "Job assistant"], "text travels as argv, never spliced into AppleScript source");
  assert.match(seen.args.join("\n"), /display notification \(item 1 of argv\) with title \(item 2 of argv\)/);
});

test("notify: also queues a Telegram copy, with the link, unless toTelegram is false", () => {
  const sent = [];
  const opts = { platform: "linux", exec: () => {}, telegram: (html) => sent.push(html) };
  notify("LinkedIn", "Ann: hi", { ...opts, link: "https://www.linkedin.com/messaging/thread/abc/" });
  notify("Job assistant", "3 new: …", { ...opts, toTelegram: false });
  assert.deepEqual(sent, [`<b>LinkedIn</b>\nAnn: hi\n<a href="https://www.linkedin.com/messaging/thread/abc/">Open</a>`]);
});
