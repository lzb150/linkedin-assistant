// closed-check.mjs as a black box: a dashboard edit that lands WHILE the probe
// runs must survive, and the closure must still be recorded. The first version
// held the whole store in memory for the entire run and wrote it back at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, symlinkSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

test("closed-check: an external state write during the run is kept, the closure is recorded, stamps written after the store", async (t) => {
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

  const run = promisify(execFile)(process.execPath, [join(dir, "closed-check.mjs")], { cwd: dir, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  // The probe loop sleeps 1 s after each url: land a "dashboard click" in that window.
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(join(dir, "job-state.json"), JSON.stringify({ _meta: {}, "https://other/": { status: "applied", appliedAt: "2026-09-07T10:00:00Z" } }));
  const { stdout } = await run;

  assert.match(stdout, /1 closed, 1 probed/);
  const state = JSON.parse(readFileSync(join(dir, "job-state.json"), "utf8"));
  assert.equal(state[U].status, "closed", "closure recorded");
  assert.equal(state["https://other/"].status, "applied", "the concurrent dashboard edit survived");
  assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "closed-check-state.json"), "utf8"))).includes(U), "check stamp written");
});
