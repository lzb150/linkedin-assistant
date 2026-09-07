import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackages, archivePackages } from "../lib/packages.mjs";

const pkg = (url) => `---\nsource: dou\ntitle: SDET\ncompany: Acme\nurl: ${url}\ngenerated: 2026-09-01T00:00:00Z\n---\n# SDET\n`;

test("readPackages: frontmatter + file per .md, non-.md and unreadable skipped (warn called), archive/ ignored, missing dir → []", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.md"), pkg("https://x/1"));
  writeFileSync(join(dir, "b.md"), pkg("https://x/2"));
  writeFileSync(join(dir, "index.html"), "<html>");
  mkdirSync(join(dir, "broken.md"));                       // a directory named *.md: readFileSync throws
  mkdirSync(join(dir, "archive")); writeFileSync(join(dir, "archive", "old.md"), pkg("https://x/old"));
  const warned = [];
  const out = readPackages(dir, { warn: (f, e) => warned.push([f, typeof e.message]) });
  assert.deepEqual(out.map((p) => [p.file, p.url, p.source, p.company]).sort(), [["a.md", "https://x/1", "dou", "Acme"], ["b.md", "https://x/2", "dou", "Acme"]]);
  assert.deepEqual(warned, [["broken.md", "string"]]);
  assert.deepEqual(readPackages(join(dir, "nope")), []);
});

test("archivePackages moves the given files into <dir>/archive and returns the count", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ["a.md", "b.md", "c.md"]) writeFileSync(join(dir, f), pkg("https://x/" + f));
  assert.equal(archivePackages(dir, ["a.md", "c.md"]), 2);
  assert.deepEqual(readdirSync(dir).sort(), ["archive", "b.md"]);
  assert.deepEqual(readdirSync(join(dir, "archive")).sort(), ["a.md", "c.md"]);
  assert.equal(archivePackages(dir, []), 0);
  assert.ok(existsSync(join(dir, "archive")));
});
