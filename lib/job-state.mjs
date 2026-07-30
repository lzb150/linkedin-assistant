// Pure model + atomic store for dashboard job state. State is keyed by vacancy
// URL. A missing entry (or an entry with no status) means status "new".
// Shape: { _meta: { lastVisit? }, "<url>": { status?, appliedAt?, note?, updatedAt? } }
import { writeFileSync, readFileSync, renameSync } from "node:fs";

const STATUSES = new Set(["viewed", "applied", "answered", "interview", "rejected"]); // "new" is virtual, never stored

const nonEmpty = (e) =>
  e && (STATUSES.has(e.status) || (typeof e.note === "string" && e.note.length) || e.appliedAt);

export function normalize(raw) {
  const out = { _meta: {} };
  if (!raw || typeof raw !== "object") return out;
  if (raw._meta && typeof raw._meta === "object") out._meta = { ...raw._meta };
  for (const [key, val] of Object.entries(raw)) {
    if (key === "_meta") continue;
    // Legacy shape: a bare status string.
    const e = typeof val === "string"
      ? { status: val, updatedAt: new Date().toISOString() }
      : { ...val };
    if (!STATUSES.has(e.status)) delete e.status;
    if (typeof e.note === "string" && !e.note.length) delete e.note;
    if (nonEmpty(e)) out[key] = e;
  }
  return out;
}

export function mergeEntry(map, url, patch) {
  const out = { ...map };
  const e = { ...(out[url] || {}) };
  if ("status" in patch) {
    if (patch.status === "new") delete e.status;
    else e.status = patch.status;
  }
  if ("appliedAt" in patch) {
    if (patch.appliedAt == null) delete e.appliedAt;
    else e.appliedAt = patch.appliedAt;
  }
  if ("note" in patch) {
    if (!patch.note) delete e.note;
    else e.note = patch.note;
  }
  e.updatedAt = new Date().toISOString();
  if (nonEmpty(e)) out[url] = e;
  else delete out[url];
  return out;
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== "object") return false;
  if ("status" in patch && patch.status !== "new" && !STATUSES.has(patch.status)) return false;
  if ("appliedAt" in patch && !(patch.appliedAt === null || typeof patch.appliedAt === "string")) return false;
  if ("note" in patch && typeof patch.note !== "string") return false;
  return true;
}

export function readStore(path) {
  try {
    return normalize(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { _meta: {} };
  }
}

export function writeStore(path, map) {
  const clean = normalize(map);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, path);
  return clean;
}

export function statusOf(map, url) {
  const e = map[url];
  return e && STATUSES.has(e.status) ? e.status : "new";
}
