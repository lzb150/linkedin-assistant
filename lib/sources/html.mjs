// Shared HTML/fetch helpers for the job sources (previously copy-pasted in
// dou.mjs, djinni.mjs, workua.mjs and jooble.mjs).

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
export const HEADERS = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };
// A hung board must not stall the whole run; 20s is generous for a static page.
export const FETCH_TIMEOUT = 20_000;

const NAMED = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'",
  mdash: "—", ndash: "–", hellip: "…",
};

// Single pass on purpose: "&amp;lt;" is the author's literal "&lt;" text, so
// decoding it twice would turn it into "<". `amp` is last in the alternation so
// the named/numeric forms win when they match first.
export function decodeEntities(s) {
  return (s || "").replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(nbsp|lt|gt|quot|apos|mdash|ndash|hellip)|(amp));/gi,
    (m, dec, hex, name, amp) => {
      if (amp) return "&";
      if (name) return NAMED[name.toLowerCase()];
      const cp = parseInt(dec ?? hex, dec ? 10 : 16);
      // NUL and lone surrogates are valid code points but garbage in text.
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return "";
      try { return String.fromCodePoint(cp); } catch { return m; }
    },
  );
}

// Tags first, entities second — otherwise escaped "&lt;b&gt;" text would decode
// into a tag and be stripped as markup.
export function stripHtml(s) {
  return decodeEntities((s || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Extract the inner HTML of the first <div> whose opening tag matches `openRe`,
// counting nested <div>s so the whole block is captured (a non-greedy regex
// would cut nested markup short). Used by djinni.mjs and workua.mjs.
export function extractDiv(html, openRe) {
  // A "</div>" inside a comment, <script> or <style> is not markup but would
  // still be counted by the depth scan below — drop those blocks first.
  html = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const m = openRe.exec(html);
  if (!m) return "";
  let depth = 1;
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = m.index + m[0].length;
  let t;
  while ((t = tag.exec(html))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(m.index + m[0].length, t.index);
  }
  return html.slice(m.index + m[0].length);
}

// Extract the inner HTML of the first <div> whose class contains `className`.
export function extractDivByClass(html, className) {
  return extractDiv(html, new RegExp(`<div[^>]*class="[^"]*${className}[^"]*"[^>]*>`, "i"));
}

// Text blob the relevance scorer sees: title + company + location + description.
export function composeText(job, description) {
  return `${job.title}${job.company ? ` at ${job.company}` : ""}. ${job.location}. ${description}`.trim();
}

// GET a page as text; logs and returns "" on a non-2xx status so callers keep
// their fallback (snippet / skip). Network errors still throw for the caller's
// own error log.
export async function fetchText(url, log, label, headers = HEADERS, doFetch = globalThis.fetch) {
  const res = await doFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) { log(`  ${label} ${res.status}: ${url}`); return ""; }
  return res.text();
}

// Run `worker` over `items` with at most `limit` in flight at once.
export async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}
