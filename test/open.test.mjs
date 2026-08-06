import { test } from "node:test";
import assert from "node:assert/strict";
import { openPath, openCommand } from "../lib/open.mjs";

test("openCommand per platform", () => {
  assert.deepEqual(openCommand("http://x/", "darwin"), ["open", ["http://x/"]]);
  assert.deepEqual(openCommand("/tmp/i.html", "linux"), ["xdg-open", ["/tmp/i.html"]]);
});

test("openPath passes through exec and never throws", () => {
  let seen;
  openPath("target", { platform: "linux", exec: (cmd, args, cb) => { seen = { cmd, args }; cb(null); } });
  assert.equal(seen.cmd, "xdg-open");
  openPath("target", { platform: "darwin", exec: () => { throw new Error("boom"); } });
});
