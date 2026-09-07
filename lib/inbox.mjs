// Pure per-thread decisions for check.mjs (the inbox scanner has no browserless
// test path, so the logic that decides what a thread IS lives here).
import { createHash } from "node:crypto";

// Stable id from the thread url — the /thread/<id> segment only (query/hash
// must not leak into the seen key). URL-less fallback hashes name + the OLDEST
// bubble (not the first of the last-12 window, which shifts as replies arrive).
export function threadIdFrom(url, name, oldest) {
  const m = String(url || "").match(/thread\/([^/?#]+)/);
  return m ? m[1] : `name:${createHash("sha1").update(`${name}\n${oldest}`).digest("hex").slice(0, 12)}`;
}

// What to do with an opened thread. `markSeen` = suppress it for the seen TTL.
//   already  — processed on an earlier run (re-stamp so the TTL is "last seen")
//   retry    — extraction failed OR no message bubbles at all: an opened thread
//              always has one, so zero is selector drift, not content. Leave it
//              unseen so the next run retries instead of burying it for 90 days.
//   not-job  — bubbles exist but the text is not a job message
//   process  — score it and maybe draft a reply
export function threadOutcome({ bubbleCount, text, extractFailed, alreadySeen, isJob }) {
  if (alreadySeen) return { action: "already", markSeen: true };
  if (extractFailed || bubbleCount === 0) return { action: "retry", markSeen: false };
  if (!text || !isJob) return { action: "not-job", markSeen: true };
  return { action: "process", markSeen: false };
}
