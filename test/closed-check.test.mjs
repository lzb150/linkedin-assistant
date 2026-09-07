// closed-check.mjs as a black box. The probe runs for minutes while the
// dashboard may write job-state.json: edits landing meanwhile must win, and a
// status the user set on the probed card beats the board's closure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { makeProject, pkg, spawnScript, runScript } from "./helpers/e2e.mjs";

// A board that reports every vacancy gone.
async function server404(t) {
  const srv = createServer((_req, res) => { res.statusCode = 404; res.end("gone"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}
const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
// The fixture board lives on loopback; the host allowlist must be told so.
const LOCAL = { CLOSED_EXTRA_HOSTS: JSON.stringify({ dou: "127.0.0.1" }) };

test("closed-check: edits landing during the run win — another url's status survives, and Applied on the probed url beats the closure", async (t) => {
  const U = `${await server404(t)}/vacancies/1/`;
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "a.md": pkg({ url: U }) },
    state: { _meta: {}, "https://other/": { status: "viewed" } },
    bins: quiet,
  });

  // Two "dashboard clicks" land after the script's initial read (its stdout
  // shows `probing`) and before its 1 s post-probe sleep. Triggering on output,
  // not a timer: a timer could fire before the read on a slow runner and the
  // test would pass without racing anything.
  const run = spawnScript(p, "closed-check.mjs", LOCAL);
  await run.output(/probing \d+ of/);
  writeFileSync(p.path("job-state.json"), JSON.stringify({ _meta: {},
    "https://other/": { status: "applied", appliedAt: "2026-09-07T10:00:00Z" },
    [U]: { status: "applied", appliedAt: "2026-09-07T10:00:01Z" } }));
  const out = await run.done;

  assert.match(out, /✗ closed \[404\]/, "the board did report it closed");
  assert.match(out, /0 closed, 1 probed/, "…but the user's Applied wins, so nothing was saved as closed");
  const state = p.json("job-state.json");
  assert.equal(state[U].status, "applied", "Applied set during the run is not overwritten by the closure");
  assert.equal(state["https://other/"].status, "applied", "the concurrent edit on another url survived");
  assert.ok(Object.keys(p.json("closed-check-state.json")).includes(U), "check stamp written");
});

test("closed-check: with no concurrent edit the closure is recorded", async (t) => {
  const U = `${await server404(t)}/vacancies/2/`;
  const p = makeProject(t, { scripts: ["closed-check.mjs"], packages: { "b.md": pkg({ url: U }) }, state: { _meta: {} }, bins: quiet });
  assert.match(await runScript(p, "closed-check.mjs", LOCAL), /1 closed, 1 probed/);
  assert.equal(p.json("job-state.json")[U].status, "closed");
});
