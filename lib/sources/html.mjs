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
// Tag scans are length-bounded: a real tag is never 4 KB, and unbounded [^>]+
// is O(n²) on junk pages full of unclosed "<" (measured: 200 KB → ~1 min).
export function stripHtml(s) {
  // Second pass catches the rare >4 KB tag (inline SVG, data: URI) so markup
  // never leaks into scored text; it only runs on what the bounded pass left.
  return decodeEntities((s || "").replace(/<[^<>]{0,4096}>/g, " ").replace(/<[^<>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Extract the inner HTML of the first <div> whose opening tag matches `openRe`,
// counting nested <div>s so the whole block is captured (a non-greedy regex
// would cut nested markup short). Used by djinni.mjs and workua.mjs.
// Drop <!-- --> comments and <script>/<style> blocks with a linear indexOf
// scan. A regex here (even a bounded lazy one) is O(n²) on pages full of
// unterminated openers — measured 6 s on 200 KB. Unterminated blocks run to EOF,
// which is also what browsers do.
export function stripBlocks(html) {
  const lower = html.toLowerCase();
  let out = "", i = 0;
  while (i < html.length) {
    const starts = [html.indexOf("<!--", i), lower.indexOf("<script", i), lower.indexOf("<style", i)].filter((x) => x >= 0);
    if (!starts.length) { out += html.slice(i); break; }
    const start = Math.min(...starts);
    out += html.slice(i, start);
    let end;
    if (html.startsWith("<!--", start)) {
      end = html.indexOf("-->", start + 4);
      end = end < 0 ? html.length : end + 3;
    } else {
      const close = lower.startsWith("<script", start) ? "</script" : "</style";
      end = lower.indexOf(close, start);
      if (end < 0) end = html.length;
      else { const gt = html.indexOf(">", end); end = gt < 0 ? html.length : gt + 1; }
    }
    i = end;
  }
  return out;
}

export function extractDiv(html, openRe) {
  // A "</div>" inside a comment, <script> or <style> is not markup but would
  // still be counted by the depth scan below — drop those blocks first.
  html = stripBlocks(html);
  const m = openRe.exec(html);
  if (!m) return "";
  let depth = 1;
  const tag = /<\/?div\b[^>]{0,2048}>/gi;
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
  return extractDiv(html, new RegExp(`<div\\b[^>]{0,2048}class="[^"]{0,512}${className}[^"]{0,512}"[^>]{0,2048}>`, "i"));
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
