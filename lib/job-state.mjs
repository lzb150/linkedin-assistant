// Pure model + atomic store for dashboard job state. State is keyed by vacancy
// URL. A missing entry (or an entry with no status) means status "new".
// Shape: { _meta: { lastVisit? }, "<url>": { status?, appliedAt?, note?, updatedAt? } }
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { writeJsonAtomic } from "./json-file.mjs";

// One merge implementation for server and browser: the dashboard client core
// is DOM-free classic JS, so it is require()-able here as well as inlined.
const core = createRequire(import.meta.url)("./dashboard-client-core.cjs");
const { mergeEntryLocal } = core;

const STATUSES = new Set(core.STATUSES); // single source of truth: dashboard-client-core.cjs ("new" is virtual, never stored)

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
  const e = mergeEntryLocal(out[url], patch);
  if (e) out[url] = { ...e, updatedAt: new Date().toISOString() };
  else delete out[url];
  return out;
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== "object") return false;
  if ("status" in patch && patch.status !== "new" && !STATUSES.has(patch.status)) return false;
  if ("appliedAt" in patch && !(patch.appliedAt === null || typeof patch.appliedAt === "string")) return false;
  if ("note" in patch && (typeof patch.note !== "string" || patch.note.length > 10_000)) return false;
  return true;
}

export function readStore(path) {
  try {
    return normalize(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    // Only a missing file is "empty store". A corrupt/unreadable file must
    // throw: swallowing it here made the next writeStore truncate real data.
    if (e.code === "ENOENT") return { _meta: {} };
    throw e;
  }
}

export function writeStore(path, map) {
  const clean = normalize(map);
  writeJsonAtomic(path, clean, 2);
  return clean;
}

export function statusOf(map, url) {
  const e = map[url];
  return e && STATUSES.has(e.status) ? e.status : "new";
}
