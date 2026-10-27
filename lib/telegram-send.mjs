// Detached sender, started by queueTelegram (lib/telegram.mjs) once per burst
// of queued messages. Drains telegram-outbox/ under a lock, so two runs that queue
// at once never post the same message twice. A drain stopped by the network (a
// Mac that has just woken) is retried a few times over ~7 minutes; whatever is
// still queued after that goes out with the next queued message.
import { readdirSync } from "node:fs";
import { acquireProfileLock } from "./run-lock.mjs";
import { drainOutbox, OUTBOX } from "./telegram.mjs";

const RETRY_MS = [30_000, 120_000, 300_000];
const MAX_ROUNDS = 50;   // a bound, not a budget: each round must send or drop something to go on
import { log } from "./log.mjs";
const pending = () => { try { return readdirSync(OUTBOX).some((f) => f.endsWith(".json")); } catch { return false; } };

for (let round = 0, retry = 0; round < MAX_ROUNDS; round++) {
  let release;
  try { release = acquireProfileLock(OUTBOX); } catch (e) {
    // Busy: another sender is draining, and it re-checks the outbox after it
    // releases the lock, so the message that started this one is not stranded.
    if (!/profile busy/.test(e.message)) log("telegram: lock failed:", e.message);
    break;
  }
  let r;
  try { r = await drainOutbox({ log }); } finally { release(); }
  if (r.sent || r.dropped || r.stopped) log(`telegram: sent ${r.sent}, dropped ${r.dropped}${r.stopped ? `, stopped (${r.stopped})` : ""}`);
  // Checked AFTER the release: a sender that found the lock busy had already
  // queued its message, so that message is visible here.
  if (!pending()) break;
  if (r.stopped === "network") {
    if (retry >= RETRY_MS.length) break;
    await new Promise((res) => setTimeout(res, RETRY_MS[retry++]));
  } else if (r.stopped || (!r.sent && !r.dropped)) break;   // config/fs need a human; no progress means no point looping
}
