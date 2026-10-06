import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeState, readPending, linkedinBadge } from "../lib/notify-state.mjs";
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

test("readPending: missing, corrupt or wrong-shaped files read as []", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readPending(join(dir, "none.json")), []);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readPending(join(dir, "bad.json")), []);
  writeFileSync(join(dir, "odd.json"), JSON.stringify({ pending: [{ id: 1 }, null, { id: "2-x", label: "A" }] }));
  assert.deepEqual(readPending(join(dir, "odd.json")), [{ id: "2-x", label: "A" }]);
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
