// Atomic writes: sibling temp file + fsync + rename, so a reader (or a crash
// mid-write / power loss) never sees a half-written or empty file.
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Read a JSON file. Only a MISSING file yields `fallback`; an unreadable or
// malformed one throws.
//
// It used to swallow everything, and the callers that write this same file back
// then turned one corrupt read into a silent reset: source-health.json lost its
// 10-run baseline (so degradation alerting went quiet for the next 5 runs with
// nothing in the log), and closed-check-state.json lost every re-check stamp
// while the fresh ones it wrote made the loss invisible. Throwing puts the
// decision where the context is — a caller that genuinely wants "any failure →
// fallback" catches it and says so out loud.
//
// Mirrors lib/job-state.mjs readStore, which throws for exactly this reason;
// lib/seen-store.mjs quarantines instead, because it owns its own file.
export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export function writeTextAtomic(path, text) {
  // pid in the tmp name: two processes writing the same file concurrently
  // (e.g. jobs.mjs + check.mjs overlap) must not clobber each other's tmp.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // 0600: these files hold scraped job text, drafted replies and job state.
    // The mode applies to the file this call CREATES; an existing target keeps
    // its own mode through the rename, so nothing already on disk is changed.
    const fd = openSync(tmp, "w", 0o600);
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
