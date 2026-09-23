import { test } from "node:test";
import assert from "node:assert/strict";

// candidate.mjs reads the env once, at import time, so each case imports it
// under a fresh specifier (the query string defeats the ESM module cache) with
// the environment already set the way that case needs it.
const load = (tag) => import(`../lib/candidate.mjs?${tag}`);

const withEnv = async (tag, env) => {
  const saved = { RESUME_PATH: process.env.RESUME_PATH, CANDIDATE_NAME: process.env.CANDIDATE_NAME };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await load(tag); } finally { Object.assign(process.env, saved); }
};

test("candidate falls back to the placeholders when the run wrapper sets nothing", async () => {
  // A fresh clone has no run.sh exports; the package must still build, with
  // values obvious enough that nobody mistakes them for real ones.
  const m = await withEnv("unset", { RESUME_PATH: undefined, CANDIDATE_NAME: undefined });
  assert.equal(m.RESUME_PATH, "~/Downloads/your-resume.docx");
  assert.equal(m.CANDIDATE_NAME, "Your Name");
});

test("candidate prefers the run wrapper's env over the placeholders", async () => {
  const m = await withEnv("set", { RESUME_PATH: "~/Downloads/resume/cv.pdf", CANDIDATE_NAME: "Ada Lovelace" });
  assert.equal(m.RESUME_PATH, "~/Downloads/resume/cv.pdf");
  assert.equal(m.CANDIDATE_NAME, "Ada Lovelace");
});

test("candidate treats an empty env value as unset", async () => {
  // RESUME_PATH= in run.sh must not put an empty "attach" line in every package.
  const m = await withEnv("empty", { RESUME_PATH: "", CANDIDATE_NAME: "" });
  assert.equal(m.RESUME_PATH, "~/Downloads/your-resume.docx");
  assert.equal(m.CANDIDATE_NAME, "Your Name");
});

test("both builders read the same constants rather than spelling their own default", async () => {
  // The whole point of the module: draft.mjs and application.mjs used to each
  // read the env and write the fallback out, so a changed default in one file
  // silently disagreed with the other.
  const { readFileSync } = await import("node:fs");
  for (const f of ["lib/draft.mjs", "lib/application.mjs"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /from "\.\/candidate\.mjs"/, `${f} imports the shared constants`);
    assert.doesNotMatch(src, /process\.env\.(RESUME_PATH|CANDIDATE_NAME)/, `${f} does not read the env itself`);
  }
});
