// One row per job source: everything the shared code needs to know about a
// board, so adding one is this row, its module in lib/sources/ and its fetch
// in jobs.mjs. Pure data with no imports: the dashboard, the Telegram sender,
// the config reader, the location filter, dedup and the closed-vacancy check
// all read it.
//
//   label, color     dashboard badge and chip, Telegram message. Colours are
//                    all ≥ 4.5:1 against white; the badge prints its text in
//                    that colour, 25% darker on the light page and 50% lighter
//                    on the dark one (--src-text in lib/dashboard.css), which
//                    keeps the 11px label ≥ 4.5:1 in both.
//   enabledDefault   DOU is on unless switched off, everything else off unless switched on.
//   needsBrowser     scraped in a logged-in Playwright context, not by fetch.
//   list             the section's list key: `valid` names a validator in
//                    lib/jobs-config.mjs, `want` is what a valid entry is called in the log.
//   flags            extra on/off keys with their defaults. `worldwide: false`
//                    keeps only jobs that name candidateCountry.
//   knobs            numeric keys with their defaults (read with sourceKnob in lib/filters.mjs).
//   countrySegment   the location is "<format> · <countries> · …" and the
//                    countries are where candidates must live (lib/filters.mjs).
//   countryList      a remote board whose location lists every eligible
//                    country: the dashboard marks the cards naming the
//                    candidate's. On Djinni and DOU naming it is the norm, so
//                    marking those would mark nearly all of them.
//   closed           closed-vacancy probe (lib/closed.mjs). Only boards that
//                    answer a plain GET and mark an inactive vacancy in the
//                    page; LinkedIn's guest job page is public and says so when
//                    closed. Boards behind Cloudflare answer 403, so only these
//                    are probed. Each marker is the board's own markup around
//                    the words (live closed pages, 2026-11-10), never the words
//                    alone: an employer's description can quote them. Each
//                    marker is a page string in ONE language (`lang`): the
//                    probe asks for that language, or a board that localises by
//                    Accept-Language answers in another and the marker never
//                    matches. `host`: the url in a package's frontmatter is
//                    board-supplied; only the board's own host is probed.
//   linkId           the part of a url path that identifies a vacancy on
//                    `host`, when the whole path does not (lib/dedup.mjs
//                    linkKey). A Djinni job is its numeric id, since the slug
//                    follows title edits.
export const SOURCE_REGISTRY = {
  dou: {
    label: "DOU", color: "#c93c33", enabledDefault: true,
    list: { key: "feeds", valid: "httpUrl", want: "a feed URL" },
    closed: { marker: /class="l-vacancy[^"]*\b__inactive\b/, lang: "uk", host: "dou.ua" },
  },
  djinni: {
    label: "Djinni", color: "#3d3bd4",
    list: { key: "searches", valid: "httpUrl", want: "a search URL" },
    knobs: { maxResults: 15, pages: 3, concurrency: 5 },   // maxResults is per page (Djinni's page size is 15)
    flags: { fullDescription: true },
    countrySegment: true,
    closed: { marker: /<div class="alert[^"]*"[^>]*>\s*<div[^>]*>\s*Ця вакансія зараз неактивна/i, lang: "uk", host: "djinni.co" },
    linkId: { host: "djinni.co", path: (p) => { const m = /^\/jobs\/(\d+)/.exec(p); return m ? `/jobs/${m[1]}` : ""; } },
  },
  himalayas: {
    label: "Himalayas", color: "#0b7a5c",
    list: { key: "searches", valid: "searchPhrase", want: "a search phrase" },
    knobs: { pages: 2 },
    flags: { worldwide: true },
    countrySegment: true, countryList: true,
  },
  tgchannels: {
    label: "Telegram", color: "#1c6aa8",
    list: { key: "channels", valid: "channelName", want: "a public channel name" },
    knobs: { pages: 1 },
    flags: { fullDescription: true, worldwide: true },
    countrySegment: true, countryList: true,
  },
  linkedin: {
    label: "LinkedIn", color: "#0a66c2", needsBrowser: true,
    list: { key: "searches", valid: "linkedInSearch", want: '{ "keywords": "…" }' },
    knobs: { maxResults: 8 },
    closed: { marker: /class="closed-job[^"]*"[^>]*>\s*No longer accepting applications/, lang: "en", host: "linkedin.com" },
  },
};

export const SOURCES = Object.keys(SOURCE_REGISTRY);

// hasOwn: a source name is frontmatter or board text, "constructor" must not resolve.
export const sourceInfo = (source) => (Object.hasOwn(SOURCE_REGISTRY, source) ? SOURCE_REGISTRY[source] : null);
