// backup.mjs: the nightly archive of everything git does not hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers/e2e.mjs";

const SCRIPT = new URL("../backup.mjs", import.meta.url).pathname;

function run(root, dest, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, BACKUP_ROOT: root, BACKUP_DIR: dest, BACKUP_KEEP: "2", ...extra },
  });
}

test("archives the state files, packages and plists, skips what is missing, rotates to BACKUP_KEEP", (t) => {
  const root = tmpDir(t);
  const dest = join(tmpDir(t), "nested", "backup");
  mkdirSync(join(root, "applications"));
  writeFileSync(join(root, "applications", "a.md"), "# a");
  writeFileSync(join(root, "job-state.json"), "{}");
  writeFileSync(join(root, "com.me.closed-check.plist"), "<plist/>");
  writeFileSync(join(root, "com.example.x.plist.example"), "not a live plist");
  mkdirSync(dest, { recursive: true });
  for (const d of ["2026-01-01", "2026-01-02", "2026-01-03"]) writeFileSync(join(dest, `linkedin-assistant-${d}.tgz`), "old");
  writeFileSync(join(dest, "unrelated.tgz"), "keep");

  const r = run(root, dest);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const today = new Date().toISOString().slice(0, 10);
  const archive = join(dest, `linkedin-assistant-${today}.tgz`);
  assert.ok(existsSync(archive), "archive written");
  const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean).map((p) => p.replace(/\/$/, ""));
  assert.ok(listed.includes("applications/a.md"), listed.join(","));
  assert.ok(listed.includes("job-state.json"));
  assert.ok(listed.includes("com.me.closed-check.plist"), "live plists go in");
  assert.ok(!listed.some((p) => p.endsWith(".example")), "templates are in git already");
  assert.ok(!listed.some((p) => /drafts|resume/.test(p)), "missing items are skipped, not an error");
  const kept = readdirSync(dest).filter((f) => f.startsWith("linkedin-assistant-")).sort();
  assert.deepEqual(kept, ["linkedin-assistant-2026-01-03.tgz", `linkedin-assistant-${today}.tgz`], "newest BACKUP_KEEP=2 kept");
  assert.ok(existsSync(join(dest, "unrelated.tgz")), "only our archives are rotated");
  assert.ok(!readdirSync(dest).some((f) => /\.tmp-/.test(f)), "no tmp file left");
  const hb = JSON.parse(readFileSync(join(root, "last-success.json"), "utf8"));
  assert.ok(hb.jobs.backup?.at, "the backup stamps its own heartbeat");
});

test("an empty root exits 1 instead of writing an empty archive", (t) => {
  const r = run(tmpDir(t), join(tmpDir(t), "b"));
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /nothing to back up/);
});
