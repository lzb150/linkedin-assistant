// Atomic read/write of the notifier state file shared between check.mjs (the
// SOLE writer) and the persistent Notifier.app daemon (the reader). The daemon
// polls this file to drive the Dock badge and to post new-message banners.
//
// Shape: { count: number, pending: [{ id, sender, text }], updatedAt: ISOString }
//   count   - total unread LinkedIn message threads -> Dock badge number
//   pending - new-message banners for the daemon to present (id dedupes)

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
