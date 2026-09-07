import { test } from "node:test";
import assert from "node:assert/strict";
import { threadIdFrom, threadOutcome } from "../lib/inbox.mjs";

test("threadIdFrom: the /thread/<id> segment, query and hash never leak; url-less falls back to name + OLDEST bubble hash", () => {
  assert.equal(threadIdFrom("https://www.linkedin.com/messaging/thread/2-abc==/?x=1#y", "Anna", "hi"), "2-abc==");
  const a = threadIdFrom("https://www.linkedin.com/messaging/", "Anna", "first message");
  const b = threadIdFrom("https://www.linkedin.com/messaging/", "Anna", "first message");
  const c = threadIdFrom("https://www.linkedin.com/messaging/", "Anna", "other first message");
  assert.match(a, /^name:[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("threadOutcome: zero bubbles on an opened thread is selector drift → retry next run, never marked seen", () => {
  assert.deepEqual(threadOutcome({ bubbleCount: 0, text: "", extractFailed: false, alreadySeen: false, isJob: false }), { action: "retry", markSeen: false });
  assert.deepEqual(threadOutcome({ bubbleCount: 3, text: "x", extractFailed: true, alreadySeen: false, isJob: true }), { action: "retry", markSeen: false });
});

test("threadOutcome: already seen → re-stamp; bubbles without job text → not-job (seen); job text → process", () => {
  assert.deepEqual(threadOutcome({ bubbleCount: 2, text: "hello", extractFailed: false, alreadySeen: true, isJob: true }), { action: "already", markSeen: true });
  assert.deepEqual(threadOutcome({ bubbleCount: 2, text: "", extractFailed: false, alreadySeen: false, isJob: false }), { action: "not-job", markSeen: true }, "bubbles exist but carry no text (images only)");
  assert.deepEqual(threadOutcome({ bubbleCount: 2, text: "thanks!", extractFailed: false, alreadySeen: false, isJob: false }), { action: "not-job", markSeen: true });
  assert.deepEqual(threadOutcome({ bubbleCount: 2, text: "We are hiring an SDET", extractFailed: false, alreadySeen: false, isJob: true }), { action: "process", markSeen: false });
});
