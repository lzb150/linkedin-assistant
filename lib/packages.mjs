// The application packages on disk (applications/*.md), read the one way every
// script needs them: frontmatter + file name, one bad file skipped, the
// archive/ subfolder and non-.md files ignored, a missing folder = no packages.
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, fmValue, frontmatterOf, addFrontmatterLine } from "./frontmatter.mjs";
import { writeTextAtomic } from "./json-file.mjs";

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
      // No frontmatter at all is a failed read, not an empty one: the entry
      // used to be pushed as a bare { file }, which the dashboard silently
      // dropped and — worse — which left closed-check's partialRead gate off,
      // so it went on pruning state against a view of the packages it knew was
      // incomplete for I/O errors but not for this.
      const fm = parseFrontmatter(text);
      if (!fm) { warn(file, new Error("no frontmatter")); continue; }
      out.push({ ...fm, ...(raw ? { _raw: text } : {}), file });
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
  if (!files.length) return moved;   // nothing to move: no archive/ is created either
  // One mkdir for the batch, not one per file. If it fails, no rename can
  // succeed: every package is reported and stays put, as before.
  try { mkdirSync(join(dir, "archive"), { recursive: true, mode: 0o700 }); }
  catch (e) { for (const f of files) warn(f, e); return moved; }
  for (const f of files) {
    try { renameSync(join(dir, f), join(dir, "archive", f)); moved.push(f); }
    catch (e) { warn(f, e); }
  }
  return moved;
}

// Write `closed: <at>` into the frontmatter of a package archived as closed
// (`dir` is the archive). The job-state entry that said so is pruned with the archive, and
// jobs.mjs needs the fact to tell a later re-listing (a repost) from a vacancy
// it has merely seen. → false (nothing written) without frontmatter or when the
// package already says it; throws on an I/O error.
export function markClosed(dir, file, at) {
  const path = join(dir, file);
  const fm = frontmatterOf(readFileSync(path, "utf8"));
  if (!fm || /^closed:/m.test(fm.block)) return false;
  writeTextAtomic(path, addFrontmatterLine(fm.md, `closed: ${fmValue(at)}`));
  return true;
}
