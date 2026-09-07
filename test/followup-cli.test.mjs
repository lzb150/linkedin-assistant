// followup.mjs as a black box: a second run the same day must not re-fire the
// reminder. (A refactor once dropped the readFileSync import; the swallowed
// ReferenceError made the dedupe file unreadable and every run re-notified.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, symlinkSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function waitFor(path, re, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    try { const s = readFileSync(path, "utf8"); if (re.test(s)) return s; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

test("followup.mjs fires a due reminder once per day, not on every run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "followup-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(ROOT, "followup.mjs"), join(dir, "followup.mjs"));
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });   // copy, not symlink: notify.mjs must not find the real Jobs.app
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "applications"));
  const U = "https://jobs.dou.ua/companies/acme/vacancies/1/";
  writeFileSync(join(dir, "applications", "a.md"), `---\nsource: dou\ntitle: SDET\ncompany: Acme\nurl: ${U}\ngenerated: 2026-08-01T00:00:00Z\n---\n# SDET\n`);
  const appliedAt = new Date(Date.now() - 9 * 86400000).toISOString();
  writeFileSync(join(dir, "job-state.json"), JSON.stringify({ _meta: {}, [U]: { status: "applied", appliedAt, updatedAt: appliedAt } }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  for (const n of ["osascript", "notify-send"]) { writeFileSync(join(bin, n), `#!/bin/sh\necho "$*" >> "${dir}/notify.log"\n`); chmodSync(join(bin, n), 0o755); }
  const run = () => promisify(execFile)(process.execPath, [join(dir, "followup.mjs")], { cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });

  const first = await run();
  assert.match(first.stdout, /1 reminder\(s\) fired/);
  const log1 = await waitFor(join(dir, "notify.log"), /Acme/);
  assert.equal((log1.match(/Acme/g) || []).length, 1, "one banner after the first run");

  const second = await run();
  assert.match(second.stdout, /0 reminder\(s\) fired/, "same-day re-run is deduped");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((readFileSync(join(dir, "notify.log"), "utf8").match(/Acme/g) || []).length, 1, "no second banner");
});
