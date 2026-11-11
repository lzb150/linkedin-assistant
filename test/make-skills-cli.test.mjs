// make-skills.mjs argument handling as a black box. The two paths below need
// no LLM: both stop before the CLI call, once the resume has been located.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject, tmpDir, spawnScript } from "./helpers/e2e.mjs";

// The run must fail; resolves with spawnScript's error text (exit code + output).
async function failure(p, args) {
  try { await spawnScript(p, "make-skills.mjs", {}, args).done; } catch (e) { return e.message; }
  assert.fail("make-skills.mjs exited 0");
}

test("make-skills.mjs: an absolute --resume path is used as given, not joined under the repo", async (t) => {
  // path.join(repo, "/Users/me/cv.txt") looked under <repo>/Users/me/cv.txt and
  // reported the file missing. A short file proves it was found where it is.
  const p = makeProject(t, { scripts: ["make-skills.mjs"] });
  const cv = join(tmpDir(t, "cv-"), "cv.txt");
  writeFileSync(cv, "too short");
  const out = await failure(p, ["--resume", cv, "--print"]);
  assert.match(out, /exit 1/);
  assert.match(out, /cv\.txt is only 9 characters/);
  assert.doesNotMatch(out, /not found/);
});

test("make-skills.mjs: a relative --resume path stays repo-relative", async (t) => {
  const p = makeProject(t, { scripts: ["make-skills.mjs"], files: { "cv.txt": "too short" } });
  const out = await failure(p, ["--resume", "cv.txt", "--print"]);
  assert.match(out, /exit 1/);
  assert.match(out, /cv\.txt is only 9 characters/);
});

test("make-skills.mjs: an unknown flag is rejected with the usage line, not silently ignored", async (t) => {
  // --prnt (a typo of --print) used to be dropped, so the run WROTE skills.json.
  const p = makeProject(t, { scripts: ["make-skills.mjs"], files: { "cv.txt": "too short" } });
  const out = await failure(p, ["--resume", "cv.txt", "--prnt"]);
  assert.match(out, /exit 1/);
  assert.match(out, /unknown option --prnt/);
  assert.match(out, /node make-skills\.mjs \[--resume/);
});
