import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeState, readBadge, linkedinBadge, keepBadgeAdding, updateState, clearStale } from "../lib/notify-state.mjs";
import { tmpDir } from "./helpers/e2e.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

test("writeState writes count, pending and updatedAt as the Jobs.app daemon reads them", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  const s = writeState(p, { count: 2, pending: [{ id: "a", sender: "Helen", text: "hi" }] });
  assert.deepEqual(read(p), s);
  assert.equal(s.count, 2);
  assert.equal(s.pending[0].sender, "Helen");
  assert.ok(Date.parse(s.updatedAt));
});

test("writeState clamps negative/fractional count and defaults pending to []", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  writeState(p, { count: -3 });
  assert.equal(read(p).count, 0);
  assert.deepEqual(read(p).pending, []);
  writeState(p, { count: 2.9, pending: "nope" });
  assert.equal(read(p).count, 2);
  assert.deepEqual(read(p).pending, []);
});

test("readBadge: missing, corrupt or wrong-shaped files read as no pending", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readBadge(join(dir, "none.json")).pending, []);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readBadge(join(dir, "bad.json")).pending, []);
  writeFileSync(join(dir, "odd.json"), JSON.stringify({ pending: [{ id: 1 }, null, { id: "2-x", label: "A" }] }));
  assert.deepEqual(readBadge(join(dir, "odd.json")).pending, [{ id: "2-x", label: "A" }]);
});

test("linkedinBadge: a bannered thread keeps the badge after the scan that read it", () => {
  // 2026-10-06: bannered at 19:17, the 20:14 scan saw 0 unread and dropped the badge.
  const first = linkedinBadge({ notified: [{ id: "2-a", label: "Maria" }], unreadCount: 1, opened: 1 });
  assert.deepEqual(first, { count: 1, pending: [{ id: "2-a", label: "Maria" }] });
  const next = linkedinBadge({ prevPending: first.pending, unreadCount: 0, opened: 0 });
  assert.deepEqual(next, first, "still 1 until a Dock click clears the file");
});

test("linkedinBadge: a repeat banner for a thread counts once, with the newest label", () => {
  const s = linkedinBadge({ prevPending: [{ id: "2-a", label: "old" }, { id: "2-b", label: "B" }], notified: [{ id: "2-a", label: "new" }], unreadCount: 1, opened: 1 });
  assert.equal(s.count, 2);
  assert.deepEqual(s.pending.map((p) => [p.id, p.label]), [["2-b", "B"], ["2-a", "new"]]);
});

test("linkedinBadge: unread threads the run did not open still count", () => {
  assert.equal(linkedinBadge({ notified: [{ id: "2-a", label: "A" }], unreadCount: 15, opened: 12 }).count, 4);
  assert.equal(linkedinBadge({ unreadCount: 0, opened: 2 }).count, 0, "opened > unread never goes negative");
});

test("keepBadgeAdding: an uncounted scan keeps the old count and adds each newly bannered thread", (t) => {
  const prev = { count: 3, pending: [{ id: "2-a", label: "Ann" }] };
  const out = keepBadgeAdding({ prev, notified: [{ id: "2-a", label: "Ann" }, { id: "2-b", label: "Bob" }] });
  assert.deepEqual(out.pending.map((p) => p.id), ["2-a", "2-b"]);
  assert.equal(out.count, 4, "2-a was already counted; 2-b adds one");
  const dir = tmpDir(t);
  writeState(join(dir, "s.json"), out);
  assert.deepEqual(readBadge(join(dir, "s.json")), { count: 4, pending: out.pending });
  assert.deepEqual(readBadge(join(dir, "none.json")), { count: 0, pending: [] });
});

test("updateState is a locked read-modify-write: the lock is released, a stale one is taken over", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  writeState(p, { count: 1, pending: [{ id: "a", label: "A" }] });
  const s = updateState(p, (prev) => linkedinBadge({ prevPending: prev.pending, notified: [{ id: "b", label: "B" }] }));
  assert.deepEqual(read(p).pending.map((x) => x.id), ["a", "b"]);
  assert.equal(s.count, 2);
  assert.ok(!existsSync(`${p}.lock`), "released");
  // A crashed holder's lock (older than 10 s) does not block the write.
  mkdirSync(`${p}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${p}.lock`, old, old);
  updateState(p, (prev) => ({ count: prev.count + 1, pending: prev.pending }));
  assert.equal(read(p).count, 3);
  assert.ok(!existsSync(`${p}.lock`), "stale lock taken over and released");
});

test("updateState waits for a live lock, then writes anyway rather than lose the update", (t) => {
  const p = join(tmpDir(t), "notify-state.json");
  mkdirSync(`${p}.lock`);   // fresh: a holder that never lets go
  const t0 = Date.now();
  updateState(p, () => ({ count: 1, pending: [] }));
  assert.ok(Date.now() - t0 >= 1900, "waited for the holder");
  assert.equal(read(p).count, 1);
  assert.ok(existsSync(`${p}.lock`), "someone else's lock is left alone");
});

test("clearStale deletes only the lock it saw stale; a fresh one taken in between is put back", (t) => {
  // Two writers both saw the crashed holder's lock stale. The first removed it
  // and took a fresh one; the second must not delete that fresh lock.
  const dir = tmpDir(t);
  const lock = join(dir, "notify-state.json.lock");
  mkdirSync(lock);
  const staleIno = statSync(lock).ino;
  clearStale(lock, staleIno);
  assert.ok(!existsSync(lock), "the lock it saw is gone");
  mkdirSync(lock);   // the other writer's fresh lock
  clearStale(lock, 0);   // stat-ed some other inode (0 is never a real one): not this lock
  assert.ok(existsSync(lock), "the fresh lock is put back");
  assert.deepEqual(readdirSync(dir), ["notify-state.json.lock"], "nothing left aside");
});
