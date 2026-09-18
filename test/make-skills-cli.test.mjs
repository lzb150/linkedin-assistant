// make-skills.mjs argument handling as a black box. The two paths below need
// no LLM: both stop before the CLI call, once the resume has been located.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeProject, tmpDir } from "./helpers/e2e.mjs";

function run(p, args) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [p.path("make-skills.mjs"), ...args], { cwd: p.dir, env: p.env, timeout: 60_000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => res({ code, out }));
  });
}

test("make-skills.mjs: an absolute --resume path is used as given, not joined under the repo", async (t) => {
  // path.join(repo, "/Users/me/cv.txt") looked under <repo>/Users/me/cv.txt and
  // reported the file missing. A short file proves it was found where it is.
  const p = makeProject(t, { scripts: ["make-skills.mjs"] });
  const cv = join(tmpDir(t, "cv-"), "cv.txt");
  writeFileSync(cv, "too short");
  const { code, out } = await run(p, ["--resume", cv, "--print"]);
  assert.equal(code, 1);
  assert.match(out, /cv\.txt is only 9 characters/);
  assert.doesNotMatch(out, /not found/);
});

test("make-skills.mjs: a relative --resume path stays repo-relative", async (t) => {
  const p = makeProject(t, { scripts: ["make-skills.mjs"], files: { "cv.txt": "too short" } });
  const { code, out } = await run(p, ["--resume", "cv.txt", "--print"]);
  assert.equal(code, 1);
  assert.match(out, /cv\.txt is only 9 characters/);
});
