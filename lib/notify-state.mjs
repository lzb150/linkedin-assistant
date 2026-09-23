// Atomic write of the notifier state files. Writers: check.mjs
// (notify-state.json) and djinni-check.mjs (djinni-notify-state.json), one
// file each. The only reader is the persistent Jobs.app daemon (jobs-app.swift),
// which polls both files and badges the Dock with the summed counts; `pending` is only the click target
// (Djinni thread ids) — banners themselves come from banners/*.json.
//
// Shape: { count: number, pending: [{ id, label }], updatedAt: ISOString }
//   count   - unread message threads in this source -> summed into the badge
//   pending - unread thread ids the daemon uses as the Dock-click target

import { writeJsonAtomic } from "./json-file.mjs";

export function writeState(path, { count = 0, pending = [] } = {}) {
  const state = {
    count: Math.max(0, Math.trunc(count) || 0),
    pending: Array.isArray(pending) ? pending : [],
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, state); // the daemon never sees a half-written file
  return state;
}
