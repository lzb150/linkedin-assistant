// How the two package builders name their files. application.mjs and draft.mjs
// each used to spell the same three rules out inline, so a change to the
// collision strategy had to be made — and tested — twice, and the two formats
// could drift apart without anyone noticing.
import { createHash } from "node:crypto";

// Minute resolution: two packages written in the same minute rely on the hash
// tail below, not the stamp, to stay apart.
export const minuteStamp = (when) => String(when).slice(0, 16).replace(/[:T]/g, "");

// Latin-only slug, capped so a long title cannot dominate the name. It is empty
// for a Cyrillic-only company or thread name — hence the hash tail.
export const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, "_").slice(0, 40);

// Short stable hash of the url: two jobs at the same company, or two threads
// drafted in the same minute, never collide.
export const shortHash = (seed) => createHash("sha1").update(String(seed)).digest("hex").slice(0, 6);
