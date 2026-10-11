// Atomic write of the notifier state files. Writers: check.mjs
// (notify-state.json) and djinni-check.mjs (djinni-notify-state.json), one
// file each. The only reader is the persistent Jobs.app daemon (jobs-app.swift),
// which polls both files and badges the Dock with the summed counts; `pending` is only the click target
// (Djinni thread ids) — banners themselves come from banners/*.json.
//
// Shape: { count: number, pending: [{ id, label }], updatedAt: ISOString }
//   count   - unread message threads in this source -> summed into the badge
//   pending - unread thread ids the daemon uses as the Dock-click target
//             (LinkedIn: threads bannered since the last Dock click, see linkedinBadge)

import { mkdirSync, rmSync, statSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./json-file.mjs";

export function writeState(path, { count = 0, pending = [] } = {}) {
  const state = {
    count: Math.max(0, Math.trunc(count) || 0),
    pending: Array.isArray(pending) ? pending : [],
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, state); // the daemon never sees a half-written file
  return state;
}

// The `pending` list of a state file; missing, corrupt or wrong-shaped -> [].
export function readPending(path) {
  return readBadge(path).pending;
}

// Count and pending list of a state file; missing, corrupt or wrong-shaped -> 0, [].
export function readBadge(path) {
  let state;
  try { state = readJson(path, {}); } catch { return { count: 0, pending: [] }; }
  return {
    count: Math.max(0, Math.trunc(Number(state?.count)) || 0),
    pending: Array.isArray(state?.pending) ? state.pending.filter((p) => typeof p?.id === "string") : [],
  };
}

// LinkedIn badge for one counted scan. Opening a thread marks it read, so the
// next hourly scan no longer lists it: a count of unread cards alone held the
// badge for an hour at most (2026-10-06: a 19:17 message, badge gone at 20:14,
// never seen). Every bannered thread stays in `pending` until a Dock click
// clears the file (Jobs.app clearBadge), deduped by id with the newest label.
// Unread threads this run did not open (the MAX cap) still count on top.
export function linkedinBadge({ prevPending = [], notified = [], unreadCount = 0, opened = 0 }) {
  const byId = new Map(prevPending.map((p) => [p.id, p]));
  for (const n of notified) { byId.delete(n.id); byId.set(n.id, n); }
  const pending = [...byId.values()];
  return { count: pending.length + Math.max(0, unreadCount - opened), pending };
}

// A scan that bannered threads but could not count the inbox (the list
// container selector drifted while the cards still matched): the count it
// would have written is unknown, so keep the previous one — but the bannered
// threads were read by opening them, and dropping them here brought back the
// badge that never showed (2026-10-06). Each newly pending thread adds one.
export function keepBadgeAdding({ prev = { count: 0, pending: [] }, notified = [] }) {
  const { pending } = linkedinBadge({ prevPending: prev.pending, notified });
  return { count: prev.count + Math.max(0, pending.length - prev.pending.length), pending };
}

// Read-modify-write of a state file under `<path>.lock/` — the same mkdir lock
// Jobs.app clearBadge takes. Unlocked, a Dock click landing between this read
// and write lost the thread just bannered (or brought back one just opened).
// Held for milliseconds, so a lock older than LOCK_STALE_MS is a crashed
// holder; after LOCK_WAIT_MS the write goes ahead unlocked rather than lose a
// badge update to a stuck lock. `next(prev)` maps { count, pending } to the
// new state; returns what was written.
const LOCK_WAIT_MS = 2000, LOCK_STALE_MS = 10_000, LOCK_POLL_MS = 20;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function updateState(path, next) {
  const lock = `${path}.lock`;
  let held = false;
  for (const t0 = Date.now(); !held && Date.now() - t0 < LOCK_WAIT_MS;) {
    try { mkdirSync(lock); held = true; }
    catch (e) {
      if (e.code !== "EEXIST") break;   // cannot lock at all (read-only dir…): write unlocked
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      sleepSync(LOCK_POLL_MS);
    }
  }
  try { return writeState(path, next(readBadge(path))); }
  finally { if (held) rmSync(lock, { recursive: true, force: true }); }
}
