// Closed-vacancy detection for closed-check.mjs. Pure: no I/O.
//
//   isClosed({ source, status, html })            → boolean
//   selectCandidates({ packages, stateMap, checked, tried, now, recheckDays, maxPerRun })
//     → [{ url, source }] — which package urls to probe this run
//   planArchive({ packages, stateMap, now, closedDays, viewedDays, borderlineDays })
//     → [file] — closed packages past the grace period, viewed packages left
//       untouched for viewedDays and borderline packages generated more than
//       borderlineDays ago, to move to applications/archive/
import { DAY_MS } from "./local-day.mjs";
import { SOURCE_REGISTRY } from "./sources/registry.mjs";

// The boards that can be probed, one row each: { marker, lang, host } (see `closed` in lib/sources/registry.mjs).
const BOARDS = Object.fromEntries(Object.entries(SOURCE_REGISTRY).filter(([, s]) => s.closed).map(([name, s]) => [name, s.closed]));
const SUPPORTED = Object.keys(BOARDS);
const pick = (field) => Object.fromEntries(SUPPORTED.map((s) => [s, BOARDS[s][field]]));
const MARKERS = pick("marker");
export const MARKER_LANG = pick("lang");
// Test seam: CLOSED_HOSTS='{"dou":"127.0.0.1:8787"}' points a board at a local server.
const HOSTS = { ...pick("host"),
  // Malformed value must not throw at import, before any handler exists — but it
  // must be loud: silently falling back to the real boards makes the e2e tests
  // that point `dou` at 127.0.0.1 issue live GETs instead of failing.
  ...(() => { try { return JSON.parse(process.env.CLOSED_HOSTS || "{}"); } catch (e) { console.error(`closed: ignoring malformed CLOSED_HOSTS — ${e.message}`); return {}; } })() };
export function onBoardHost(source, url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;   // fetch rejects other schemes anyway; be explicit
    const d = HOSTS[source];
    if (!d) return false;
    // The port must match too: a real board has none, so a redirect hop to
    // https://djinni.co:8443/ is another service on that machine, not the
    // board (tgchannels.mjs isPublicHttps refuses an explicit port for the
    // same reason). Only the test seam names one.
    const [host, port = ""] = String(d).split(":");
    return u.port === port && (u.hostname === host || u.hostname.endsWith("." + host));
  } catch { return false; }
}

export function isClosed({ source, status, html }) {
  if (status === 404 || status === 410) return true;
  if (status !== 200) return false;                // 5xx / Cloudflare page: unknown, try again later
  const re = MARKERS[source];
  return Boolean(re && re.test(String(html || "")));
}

// Probe only what can still change our behaviour: New/Viewed cards on a
// supported board. Never-checked and
// longest-unchecked first, so a big backlog drains evenly under the cap.
// The board is the url's host: a Telegram repost of a Djinni job keeps the
// channel as its source but links djinni.co, and is probed as Djinni.
//
// `tried` = when a probe last got no usable answer (429/5xx/Cloudflare/timeout).
// Such a url is not "checked", but with last = 0 forever it sorted first every
// run and, past maxPerRun of them, starved every other board: it waits a day
// instead (and sorts by the later of the two stamps).
export function selectCandidates({ packages, stateMap = {}, checked = {}, tried = {}, now = new Date(), recheckDays = 3, maxPerRun = 150 }) {
  const cutoff = now.getTime() - recheckDays * DAY_MS;
  const retryCutoff = now.getTime() - DAY_MS;
  const seen = new Set();
  const due = [];
  for (const p of packages) {
    const board = boardOf(p);
    if (!board || seen.has(p.url)) continue;
    seen.add(p.url);
    const last = lastProbe(p.url, { stateMap, checked, tried, cutoff, retryCutoff });
    if (last !== null) due.push({ url: p.url, source: board, last });
  }
  due.sort((a, b) => a.last - b.last);
  return due.slice(0, maxPerRun).map(({ url, source }) => ({ url, source }));
}

// A 404/410 closes a vacancy on one answer, and a closed url is never probed
// again — so one wrong 404 (a deploy, a soft block) lost a live vacancy for
// good: hidden from the default tabs, archived 14 days later. `gone` = when
// this checker closed a url on a 404/410. Each is probed once more, a day or
// more later, while its card is still Closed; closed-check reopens it on a 200
// without the marker.
export function selectReprobes({ packages, stateMap = {}, gone = {}, now = new Date() }) {
  const before = now.getTime() - DAY_MS;
  const seen = new Set();
  const out = [];
  for (const p of packages) {
    const at = p?.url && Object.hasOwn(gone, p.url) ? stampMs(gone[p.url]) : 0;
    const board = at && at <= before && !seen.has(p.url) && stateMap[p.url]?.status === "closed" ? boardOf(p) : null;
    if (!board) continue;
    seen.add(p.url);
    out.push({ url: p.url, source: board, reprobe: true });
  }
  return out;
}

// The supported board a package's url is on: its own source's, else any.
function boardOf(p) {
  return p?.url && (onBoardHost(p.source, p.url) ? p.source : SUPPORTED.find((s) => onBoardHost(s, p.url)));
}

// When `url` was last probed (0 = never), or null when it is not due: its card
// is past New/Viewed, the last check is newer than `cutoff`, or the last
// unanswered attempt is newer than `retryCutoff`.
function lastProbe(url, { stateMap, checked, tried, cutoff, retryCutoff }) {
  const st = stateMap[url]?.status;
  if (st && st !== "viewed") return null;          // missing status = "new"
  const last = stampMs(checked[url]);
  const attempt = stampMs(tried[url]);
  if (last > cutoff || attempt > retryCutoff) return null;
  return Math.max(last, attempt);
}

// A stored ISO stamp → epoch ms; a missing or unparsable one → 0 (never).
const stampMs = (iso) => Date.parse(iso || "") || 0;

// Packages whose vacancy has been "closed" for at least closedDays. Every
// reader lists applications/ non-recursively, so moving a file into
// applications/archive/ drops it from the dashboard, jobs.mjs and
// this checker while keeping it on disk. The grace period keeps a fresh
// closure visible (muted "· closed" cue) long enough to notice a false hit.
// Viewed packages the user has not touched for viewedDays go the same way:
// a board the probe cannot reach (Cloudflare) would otherwise pile them up
// forever (131 of 262 viewed were >30 d in 2026-09).
// New (no entry) match cards are never archived here; borderline ones age out
// by their generated date after borderlineDays, entry or not.
// An entry with no updatedAt (legacy) counts as old enough.
export function planArchive({ packages, stateMap = {}, now = new Date(), closedDays = 14, viewedDays = 30, borderlineDays = 30 }) {
  const cutoffFor = { closed: now.getTime() - closedDays * DAY_MS, viewed: now.getTime() - viewedDays * DAY_MS };
  const archivable = (p) => {
    // A borderline package nobody promoted ages out by its generated date,
    // status or not: the tab is a waiting room, not a second inbox.
    if (p?.tier === "borderline") return notAfter(p.generated, now.getTime() - borderlineDays * DAY_MS);
    const e = p?.url ? stateMap[p.url] : null;
    const cutoff = e && Object.hasOwn(cutoffFor, e.status) ? cutoffFor[e.status] : undefined;   // a hand-edited status of "toString" is not a cutoff
    return cutoff !== undefined && notAfter(e.updatedAt, cutoff);
  };
  return packages.filter(archivable).map((p) => p.file);
}

// The stamp is at or before `cutoff`; a missing or unparsable one counts as old enough.
function notAfter(stamp, cutoff) {
  const at = Date.parse(stamp || "");
  return !Number.isFinite(at) || at <= cutoff;
}
