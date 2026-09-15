// The application packages on disk (applications/*.md), read the one way every
// script needs them: frontmatter + file name, one bad file skipped, the
// archive/ subfolder and non-.md files ignored, a missing folder = no packages.
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

// → [{ file, ...frontmatter }]. `warn(file, err)` is called for an unreadable package.
// `raw: true` also returns the file's text as `_raw`. The dashboard needs the
// body (the cover note is not frontmatter) and used to read every package a
// second time to get it — and that second read is what made a package archived
// mid-build abort the whole thing.
export function readPackages(dir, { warn = () => {}, raw = false } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    // `file` last: consumers join it under applications/, so a frontmatter
    // `file:` key (board-supplied text) must never replace the real filename.
    try {
      const text = readFileSync(join(dir, file), "utf8");
      out.push({ ...parseFrontmatter(text), ...(raw ? { _raw: text } : {}), file });
    } catch (e) { warn(file, e); }
  }
  return out;
}

// Move packages into <dir>/archive/ — out of every reader's sight, still on disk.
// → the files actually moved. A rename that fails is reported via `warn(file, err)`
// and the package stays put: the caller must keep its state entry, or the
// package reappears as New on the dashboard.
export function archivePackages(dir, files, { warn = () => {} } = {}) {
  const moved = [];
  for (const f of files) {
    try { mkdirSync(join(dir, "archive"), { recursive: true }); renameSync(join(dir, f), join(dir, "archive", f)); moved.push(f); }
    catch (e) { warn(f, e); }
  }
  return moved;
}
