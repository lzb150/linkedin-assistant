// closed-check.mjs as a black box: a dashboard edit that lands WHILE the probe
// runs must survive, and the closure must still be recorded. The first version
// held the whole store in memory for the entire run and wrote it back at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, symlinkSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Spawn the script and resolve once its stdout shows `probing` — i.e. after
// its initial read of the store and before the 1 s post-probe sleep. A fixed
// timer could fire before the read on a slow runner and pass without racing.
function runClosedCheck(dir, bin) {
  const child = spawn(process.execPath, [join(dir, "closed-check.mjs")], { cwd: dir, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  let stdout = "";
  const probing = new Promise((res) => child.stdout.on("data", (d) => { stdout += d; if (/probing \d+ of/.test(stdout)) res(); }));
  child.stderr.on("data", (d) => { stdout += d; });
  const done = new Promise((res, rej) => child.on("exit", (code) => (code === 0 ? res(stdout) : rej(new Error(`exit ${code}\n${stdout}`)))));
  return { probing, done };
}

test("closed-check: edits landing during the run win — another url's status survives, and Applied on the probed url beats the closure", async (t) => {
  const srv = createServer((_req, res) => { res.statusCode = 404; res.end("gone"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = mkdtempSync(join(tmpdir(), "closed-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(ROOT, "closed-check.mjs"), join(dir, "closed-check.mjs"));
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });   // copy, not symlink: notify.mjs must not find the real Jobs.app
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "applications"));
  // "dou" package pointing at the 404 server: closed on first probe.
  const U = `http://127.0.0.1:${srv.address().port}/vacancies/1/`;
  writeFileSync(join(dir, "applications", "a.md"), `---\nsource: dou\ntitle: SDET\ncompany: Acme\nurl: ${U}\ngenerated: 2026-09-01T00:00:00Z\n---\n# SDET\n`);
  writeFileSync(join(dir, "job-state.json"), JSON.stringify({ _meta: {}, "https://other/": { status: "viewed" } }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  for (const n of ["osascript", "notify-send"]) { writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, n), 0o755); }

  // Two "dashboard clicks" land while the script is probing: another url moves
  // to applied, and the PROBED url itself is marked applied.
  const { probing, done } = runClosedCheck(dir, bin);
  await probing;
  writeFileSync(join(dir, "job-state.json"), JSON.stringify({ _meta: {},
    "https://other/": { status: "applied", appliedAt: "2026-09-07T10:00:00Z" },
    [U]: { status: "applied", appliedAt: "2026-09-07T10:00:01Z" } }));
  const stdout = await done;

  assert.match(stdout, /✗ closed \[404\]/, "the board did report it closed");
  assert.match(stdout, /0 closed, 1 probed/, "…but the user's Applied wins, so nothing was saved as closed");
  const state = JSON.parse(readFileSync(join(dir, "job-state.json"), "utf8"));
  assert.equal(state[U].status, "applied", "Applied set during the run is not overwritten by the closure");
  assert.equal(state["https://other/"].status, "applied", "the concurrent edit on another url survived");
  assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "closed-check-state.json"), "utf8"))).includes(U), "check stamp written");
});

test("closed-check: with no concurrent edit the closure is recorded", async (t) => {
  const srv = createServer((_req, res) => { res.statusCode = 404; res.end("gone"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = mkdtempSync(join(tmpdir(), "closed-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(ROOT, "closed-check.mjs"), join(dir, "closed-check.mjs"));
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "applications"));
  const U = `http://127.0.0.1:${srv.address().port}/vacancies/2/`;
  writeFileSync(join(dir, "applications", "b.md"), `---\nsource: dou\ntitle: SDET\ncompany: Acme\nurl: ${U}\ngenerated: 2026-09-01T00:00:00Z\n---\n# SDET\n`);
  writeFileSync(join(dir, "job-state.json"), JSON.stringify({ _meta: {} }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  for (const n of ["osascript", "notify-send"]) { writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, n), 0o755); }
  const stdout = await runClosedCheck(dir, bin).done;
  assert.match(stdout, /1 closed, 1 probed/);
  assert.equal(JSON.parse(readFileSync(join(dir, "job-state.json"), "utf8"))[U].status, "closed");
});
