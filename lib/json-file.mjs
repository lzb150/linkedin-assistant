// Atomic writes: sibling temp file + fsync + rename, so a reader (or a crash
// mid-write / power loss) never sees a half-written or empty file.
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Read a JSON file; a missing, unreadable or malformed file yields `fallback`.
// For state that must NOT be silently reset on corruption use job-state.mjs
// (throws) or seen-store.mjs (quarantines) instead.
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function writeTextAtomic(path, text) {
  // pid in the tmp name: two processes writing the same file concurrently
  // (e.g. jobs.mjs + check.mjs overlap) must not clobber each other's tmp.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text);   // not writeSync: one syscall may write fewer bytes than `text` holds, and rename would publish the truncation
      fsyncSync(fd); // rename is only atomic for data that already hit the disk
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    // fsync the directory too: the file's CONTENTS were flushed above, but the
    // rename is a directory operation and a power loss can lose it, leaving the
    // old file in place while the caller was told the write succeeded.
    try { const dfd = openSync(dirname(path), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch {}
  } catch (e) {
    try { unlinkSync(tmp); } catch {} // don't leave a stray .tmp behind
    throw e;
  }
}

export function writeJsonAtomic(path, value, indent = 0) {
  writeTextAtomic(path, JSON.stringify(value, null, indent));
}
