// Persistent "already processed" set with a TTL, so seen files stop growing
// forever. On disk: { key: lastSeenISO }. Legacy files were bare arrays of
// keys — migrated on load (stamped now). Entries older than ttlDays are dropped
// on load. In memory it is Set-like (has/add/size) so call sites stay tiny.
import { readFileSync, renameSync } from "node:fs";
import { writeJsonAtomic } from "./json-file.mjs";

export function loadSeenStore(file, { ttlDays = 90, now = Date.now(), isLegacy = () => false, warn = console.warn } = {}) {
  const entries = new Map();
  const cutoff = now - ttlDays * 86400_000;
  const stamp = () => new Date(now).toISOString();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(raw)) {
      // legacy array; caller may declare it stale (e.g. URL keys) → start fresh
      if (!isLegacy(raw)) for (const k of raw) entries.set(String(k), stamp());
    } else if (raw && typeof raw === "object") {
      for (const [k, iso] of Object.entries(raw)) {
        if (Date.parse(iso) >= cutoff) entries.set(k, iso);
      }
    }
  } catch (e) {
    // ENOENT = fresh start, fine. Anything else is a corrupt file: keep it
    // aside for inspection instead of silently overwriting it on save.
    if (e.code !== "ENOENT") {
      warn(`seen-store: ${file} unreadable (${e.message}) — moved to .corrupt, starting fresh`);
      try { renameSync(file, `${file}.corrupt`); } catch {}
    }
  }
  return {
    has: (k) => entries.has(k),
    add(k) { entries.set(k, stamp()); return this; },
    get size() { return entries.size; },
    save() { writeJsonAtomic(file, Object.fromEntries(entries)); },
  };
}
