// Atomic JSON write: sibling temp file + rename, so a reader (or a crash
// mid-write) never sees a half-written file.
import { writeFileSync, renameSync } from "node:fs";

export function writeJsonAtomic(path, value, indent = 0) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, indent));
  renameSync(tmp, path);
}
