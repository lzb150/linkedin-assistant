// Atomic read/write of the notifier state files. Writers: check.mjs
// (notify-state.json) and djinni-check.mjs (djinni-notify-state.json), one
// file each. Reader: the persistent Jobs.app daemon, which polls both files,
// badges the Dock with the summed counts, and banners new pending entries.
//
// Shape: { count: number, pending: [{ id, label }], updatedAt: ISOString }
//   count   - unread message threads in this source -> summed into the badge
//   pending - new-thread banners for the daemon to present (id dedupes)

import { writeFileSync, readFileSync, renameSync } from "node:fs";

export function readState(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      count: Number.isFinite(raw.count) ? Math.max(0, Math.trunc(raw.count)) : 0,
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  } catch {
    return { count: 0, pending: [], updatedAt: "" };
  }
}

export function writeState(path, { count = 0, pending = [] } = {}) {
  const state = {
    count: Math.max(0, Math.trunc(count) || 0),
    pending: Array.isArray(pending) ? pending : [],
    updatedAt: new Date().toISOString(),
  };
  // Atomic: write a sibling temp file, then rename over the target so a
  // concurrent reader (the daemon) never sees a half-written file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 0));
  renameSync(tmp, path);
  return state;
}
