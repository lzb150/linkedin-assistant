// Atomic JSON write: sibling temp file + rename, so a reader (or a crash
// mid-write) never sees a half-written file.
import { writeFileSync, renameSync } from "node:fs";

export function writeJsonAtomic(path, value, indent = 0) {
  // pid in the tmp name: two processes writing the same file concurrently
  // (e.g. jobs.mjs + check.mjs overlap) must not clobber each other's tmp.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, indent));
  renameSync(tmp, path);
}
