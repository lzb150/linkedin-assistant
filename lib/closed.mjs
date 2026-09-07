// Closed-vacancy detection for closed-check.mjs. Pure: no I/O.
//
//   isClosed({ source, status, html })            → boolean
//   selectCandidates({ packages, stateMap, checked, now, recheckDays, maxPerRun })
//     → [{ url, source }] — which package urls to probe this run

// Only boards that answer a plain GET and mark an inactive vacancy in the page.
// Jooble redirects to the employer; LinkedIn needs a login; Work.ua/Robota.ua/
// Glassdoor sit behind Cloudflare. Markers observed on live pages, 2026-09.
const MARKERS = {
  dou: /вакансія неактивна/i,
  djinni: /вакансія зараз неактивна/i,
};
export const SUPPORTED = Object.keys(MARKERS);

export function isClosed({ source, status, html }) {
  if (status === 404 || status === 410) return true;
  if (status !== 200) return false;                // 5xx / Cloudflare page: unknown, try again later
  const re = MARKERS[source];
  return Boolean(re && re.test(String(html || "")));
}

// Probe only what can still change our behaviour: New/Viewed cards on a
// supported board. Applied+ cards are the user's to close out (a vacancy
// disappearing after you applied says nothing definitive). Never-checked and
// longest-unchecked first, so a big backlog drains evenly under the cap.
export function selectCandidates({ packages, stateMap = {}, checked = {}, now = new Date(), recheckDays = 3, maxPerRun = 150 }) {
  const cutoff = now.getTime() - recheckDays * 86400000;
  const seen = new Set();
  const due = [];
  for (const p of packages) {
    if (!p?.url || !SUPPORTED.includes(p.source) || seen.has(p.url)) continue;
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
