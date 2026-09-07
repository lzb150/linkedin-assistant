// The application packages on disk (applications/*.md), read the one way every
// script needs them: frontmatter + file name, one bad file skipped, the
// archive/ subfolder and non-.md files ignored, a missing folder = no packages.
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

// → [{ file, ...frontmatter }]. `warn(file, err)` is called for an unreadable package.
export function readPackages(dir, { warn = () => {} } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try { out.push({ file, ...(parseFrontmatter(readFileSync(join(dir, file), "utf8")) || {}) }); }
    catch (e) { warn(file, e); }
  }
  return out;
}

// Move packages into <dir>/archive/ — out of every reader's sight, still on disk.
export function archivePackages(dir, files) {
  if (!files.length) return 0;
  mkdirSync(join(dir, "archive"), { recursive: true });
  for (const f of files) renameSync(join(dir, f), join(dir, "archive", f));
  return files.length;
}
