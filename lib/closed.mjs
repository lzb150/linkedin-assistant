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
export const SUPPORTED = Object.keys(MARKERS);
// The url in a package's frontmatter is board-supplied; only probe the board's own host.
const HOSTS = { dou: "dou.ua", djinni: "djinni.co", linkedin: "linkedin.com" };
// `extraHosts` lets a test (or a board mirror) add hosts per source.
export function onBoardHost(source, url, extraHosts = {}) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;   // fetch rejects other schemes anyway; be explicit
    const h = u.hostname;
    const allowed = [HOSTS[source], extraHosts[source]].filter(Boolean);
    return allowed.some((d) => h === d || h.endsWith("." + d));
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
export function selectCandidates({ packages, stateMap = {}, checked = {}, now = new Date(), recheckDays = 3, maxPerRun = 150, extraHosts = {} }) {
  const cutoff = now.getTime() - recheckDays * 86400000;
  const seen = new Set();
  const due = [];
  for (const p of packages) {
    if (!p?.url || !SUPPORTED.includes(p.source) || !onBoardHost(p.source, p.url, extraHosts) || seen.has(p.url)) continue;
    seen.add(p.url);
    const st = stateMap[p.url]?.status;
    if (st && st !== "viewed") continue;           // missing status = "new"
    const last = Date.parse(checked[p.url] || "");
    if (Number.isFinite(last) && last > cutoff) continue;
    due.push({ url: p.url, source: p.source, last: Number.isFinite(last) ? last : 0 });
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
export function planArchive({ packages, stateMap = {}, now = new Date(), closedDays = 14, viewedDays = 30 }) {
  const cutoffFor = { closed: now.getTime() - closedDays * 86400000, viewed: now.getTime() - viewedDays * 86400000 };
  const out = [];
  for (const p of packages) {
    const e = p?.url ? stateMap[p.url] : null;
    const cutoff = e ? cutoffFor[e.status] : undefined;
    if (cutoff === undefined) continue;
    const at = Date.parse(e.updatedAt || "");
    if (!Number.isFinite(at) || at <= cutoff) out.push(p.file);
  }
  return out;
}
