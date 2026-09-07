// Shared scaffolding for the black-box CLI tests. (node --test test/ also runs
// this file as an empty test — one harmless "ok" line.) (jobs.mjs, closed-check.mjs,
// followup.mjs): a throwaway project dir with the script, a COPY of lib/ (not
// a symlink — Node resolves ESM through realpath, and a symlinked notify.mjs
// would compute ROOT as the real repo and queue banners into the user's
// Jobs.app), a node_modules symlink, fixture packages/state and fake binaries
// on PATH. notify.mjs falls back to osascript on macOS and notify-send on
// Linux (CI runs both), so both fakes are always present and log to notify.log.
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, symlinkSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

// A minimal application package (frontmatter + heading).
export const pkg = ({ source = "dou", title = "SDET", company = "Acme", url, generated = "2026-09-01T00:00:00Z" }) =>
  `---\nsource: ${source}\ntitle: ${title}\ncompany: ${company}\nurl: ${url}\ngenerated: ${generated}\n---\n# ${title}\n`;

const LOG_ARGS = (dir, file) => `#!/bin/sh\necho "$*" >> "${dir}/${file}"\n`;

/**
 * @param t node:test context (for cleanup)
 * @param scripts  root files to copy in (e.g. ["jobs.mjs", "dashboard.mjs", "skills.json"])
 * @param packages { "a.md": "<markdown>" } written under applications/
 * @param state    object written as job-state.json (omit for none)
 * @param files    { "resume.txt": "..." } extra root files
 * @param bins     { claude: "<sh script>" } extra/override fake binaries; osascript + notify-send default to logging into notify.log
 */
export function makeProject(t, { scripts = [], packages = {}, state, files = {}, bins = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of scripts) copyFileSync(join(ROOT, f), join(dir, f));
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "applications"));
  for (const [name, md] of Object.entries(packages)) writeFileSync(join(dir, "applications", name), md);
  if (state) writeFileSync(join(dir, "job-state.json"), JSON.stringify(state));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const all = { osascript: LOG_ARGS(dir, "notify.log"), "notify-send": LOG_ARGS(dir, "notify.log"), ...bins };
  for (const [name, body] of Object.entries(all)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  return { dir, bin, env, path: (...p) => join(dir, ...p), read: (...p) => readFileSync(join(dir, ...p), "utf8"), json: (...p) => JSON.parse(readFileSync(join(dir, ...p), "utf8")) };
}

// Run a project script. Async on purpose: a sync spawn would block this
// process's event loop, and fixture HTTP servers live in it.
//   const run = spawnScript(p, "closed-check.mjs");
//   await run.output(/probing/);   // resolve once stdout+stderr matches
//   const out = await run.done;    // resolves with the combined output on exit 0
export function spawnScript(p, script, env = {}) {
  const child = spawn(process.execPath, [p.path(script)], { cwd: p.dir, env: { ...p.env, ...env } });
  let out = "";
  const waiters = [];
  const onData = (d) => { out += d; for (const w of waiters) if (w.re.test(out)) w.res(); };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  const done = new Promise((res, rej) => child.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`${script} exit ${code}\n${out}`)))));
  return { done, output: (re) => (re.test(out) ? Promise.resolve() : new Promise((res) => waiters.push({ re, res }))) };
}
export const runScript = (p, script, env) => spawnScript(p, script, env).done;

// Wait until a file exists AND matches — fire-and-forget notifiers write it a
// few ms after the script has exited, sometimes in several writes.
export async function waitFor(path, re, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    try { const s = readFileSync(path, "utf8"); if (re.test(s)) return s; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
