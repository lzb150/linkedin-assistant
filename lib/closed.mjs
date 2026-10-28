// Closed-vacancy detection for closed-check.mjs. Pure: no I/O.
//
//   isClosed({ source, status, html })            → boolean
//   selectCandidates({ packages, stateMap, checked, now, recheckDays, maxPerRun })
//     → [{ url, source }] — which package urls to probe this run
//   planArchive({ packages, stateMap, now, closedDays, viewedDays })
//     → [file] — closed packages past the grace period and viewed packages left
//       untouched for viewedDays, to move to applications/archive/

// Only boards that answer a plain GET and mark an inactive vacancy in the page.
// LinkedIn's guest job page is public (no login) and says so when closed.
// Boards behind Cloudflare answer 403 to a plain GET, so only these are probed. Markers observed on live pages, 2026-09.
const MARKERS = {
  dou: /вакансія неактивна/i,
  djinni: /вакансія зараз неактивна/i,
  linkedin: /No longer accepting applications/,
};
// Each marker is a page string in ONE language: the probe asks for that
// language, or a board that localises by Accept-Language answers in another
// and the marker never matches.
export const MARKER_LANG = { dou: "uk", djinni: "uk", linkedin: "en" };
const SUPPORTED = Object.keys(MARKERS);
// The url in a package's frontmatter is board-supplied; only probe the board's own host.
// Test seam: CLOSED_HOSTS='{"dou":"127.0.0.1:8787"}' points a board at a local server.
const HOSTS = { dou: "dou.ua", djinni: "djinni.co", linkedin: "linkedin.com",
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
export function selectCandidates({ packages, stateMap = {}, checked = {}, now = new Date(), recheckDays = 3, maxPerRun = 150 }) {
  const cutoff = now.getTime() - recheckDays * 86400000;
  const seen = new Set();
  const due = [];
  for (const p of packages) {
    const board = p?.url && (onBoardHost(p.source, p.url) ? p.source : SUPPORTED.find((s) => onBoardHost(s, p.url)));
    if (!board || seen.has(p.url)) continue;
    seen.add(p.url);
    const st = stateMap[p.url]?.status;
    if (st && st !== "viewed") continue;           // missing status = "new"
    const last = Date.parse(checked[p.url] || "");
    if (Number.isFinite(last) && last > cutoff) continue;
    due.push({ url: p.url, source: board, last: Number.isFinite(last) ? last : 0 });
  }
  due.sort((a, b) => a.last - b.last);
  return due.slice(0, maxPerRun).map(({ url, source }) => ({ url, source }));
}

// Packages whose vacancy has been "closed" for at least closedDays. Every
// reader lists applications/ non-recursively, so moving a file into
// applications/archive/ drops it from the dashboard, jobs.mjs and
// this checker while keeping it on disk. The grace period keeps a fresh
// closure visible (muted "· closed" cue) long enough to notice a false hit.
// Viewed packages the user has not touched for viewedDays go the same way:
// a board the probe cannot reach (Cloudflare) would otherwise pile them up
// forever (131 of 262 viewed were >30 d in 2026-09).
// New (no entry) cards are never archived here.
// An entry with no updatedAt (legacy) counts as old enough.
export function planArchive({ packages, stateMap = {}, now = new Date(), closedDays = 14, viewedDays = 30, borderlineDays = 30 }) {
  const cutoffFor = { closed: now.getTime() - closedDays * 86400000, viewed: now.getTime() - viewedDays * 86400000 };
  const archivable = (p) => {
    // A borderline package nobody promoted ages out by its generated date,
    // status or not: the tab is a waiting room, not a second inbox.
    if (p?.tier === "borderline") return notAfter(p.generated, now.getTime() - borderlineDays * 86400000);
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
