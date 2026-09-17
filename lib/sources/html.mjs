// Shared HTML/fetch helpers for the job sources (dou.mjs, djinni.mjs,
// linkedin-jobs.mjs).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };
// A hung board must not stall the whole run; 20s is generous for a static page.
const FETCH_TIMEOUT = 20_000;

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
  // A forward scan rather than a regex, because a tag ends at the first ">"
  // OUTSIDE its quoted attribute values: `<a title="salary > 5000" href="#">`
  // used to be cut at the ">" inside the title, leaking `5000" href="#">` into
  // the scored text and the LLM prompt. The quote-aware version of that regex
  // needs nested quantifiers, which is exactly what made this file quadratic
  // twice before; this visits every character once and has no bound to outgrow.
  // Only tag-like tokens are removed (<letter, </, <!) — a prose
  // "salary < 5000 … > 3 years" must keep the text in between.
  const src = String(s || "");
  let out = "", i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { out += src.slice(i); break; }
    if (!/[a-zA-Z!/]/.test(src[lt + 1] || "")) { out += src.slice(i, lt + 1); i = lt + 1; continue; }
    let j = lt + 1, quote = null, end = -1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ">") { end = j; break; }
      if (ch === "<") break;   // a second "<" first: the token was never a tag
    }
    out += src.slice(i, lt);
    if (end === -1) { out += src.slice(lt, j); i = j; }   // unterminated: keep as text
    else { out += " "; i = end + 1; }
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim();
}

// Extract the inner HTML of the first <div> whose opening tag matches `openRe`,
// counting nested <div>s so the whole block is captured (a non-greedy regex
// would cut nested markup short). Used by djinni.mjs.
// Drop <!-- --> comments and <script>/<style> blocks in ONE forward pass: a
// case-insensitive opener regex driven by lastIndex, closers found with
// indexOf from the current position. Never restarts from the top (a page of
// 50k terminated comments was O(n×blocks) before) and never maps offsets
// through toLowerCase (which changes length for "İ"). Abrupt comments
// "<!-->" / "<!--->" close immediately, per the HTML spec; unterminated blocks
// run to EOF, as browsers do.
export function stripBlocks(html) {
  const opener = /<!--|<script\b|<style\b/gi;
  let out = "", i = 0, m;
  while ((m = opener.exec(html))) {
    if (m.index < i) { opener.lastIndex = i; continue; } // opener inside a block we already skipped
    out += html.slice(i, m.index);
    let end;
    if (m[0] === "<!--") {
      const a = m.index + 4;
      if (html.startsWith(">", a)) end = a + 1;
      else if (html.startsWith("->", a)) end = a + 2;
      else { const c = html.indexOf("-->", a); end = c < 0 ? html.length : c + 3; }
    } else {
      const close = new RegExp(/^<script/i.test(m[0]) ? "</script" : "</style", "gi");
      close.lastIndex = m.index;
      const c = close.exec(html);
      if (!c) end = html.length;
      else { const gt = html.indexOf(">", c.index); end = gt < 0 ? html.length : gt + 1; }
    }
    i = end;
    opener.lastIndex = end;
  }
  return out + html.slice(i);
}

// Inner HTML of the first <div> whose class contains `className`.
export function extractDivByClass(html, className) {
  // A "</div>" inside a comment, <script> or <style> is not markup but would
  // still be counted by the depth scan below — drop those blocks first.
  html = stripBlocks(html);
  // Forward scan, never backtracking: locate each "<div", take the tag text up
  // to its own ">", and test THAT for the class. The opener used to be
  // `<div\b[^>]{0,2048}class="…"`, which re-scanned up to 2048 characters at
  // every one of them on a page of unterminated "<div" tokens — 1.2 s of CPU
  // per megabyte, on the event loop. The old ReDoS guard used "<a " repeats and
  // missed this shape entirely. Same two bounds are gone on the depth scan for
  // the same reason; indexOf does that job in one pass.
  const open = /<div\b/gi;
  const want = String(className).toLowerCase();
  let start = -1, afterOpen = -1, m;
  while ((m = open.exec(html))) {
    const gt = html.indexOf(">", m.index);
    if (gt < 0) return "";   // no complete opening tag left in the document
    // Either quote style: a markup change to class='…' used to make this
    // return "" — jobs silently stopped being parsed, with nothing logged.
    const cls = html.slice(m.index, gt).toLowerCase().match(/class=["']([^"']*)["']/);
    if (cls && cls[1].includes(want)) { start = m.index; afterOpen = gt + 1; break; }
    open.lastIndex = gt + 1;
  }
  if (start < 0) return "";
  let depth = 1;
  const tag = /<\/?div\b/gi;
  tag.lastIndex = afterOpen;
  let t;
  while ((t = tag.exec(html))) {
    const gt = html.indexOf(">", t.index);
    if (gt < 0) break;   // unterminated tag: nothing further can close the block
    depth += html[t.index + 1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(afterOpen, t.index);
    tag.lastIndex = gt + 1;
  }
  return html.slice(afterOpen);
}

// Scraped fields go straight into the run log, and the weekly digest parses
// that log with ^-anchored patterns. A board title carrying "&#10;" decodes to
// a real newline and forges digest lines ("Done. Considered 500 new"), so every
// field that reaches a log line is collapsed to one line first.
export function oneLine(s) {
  // Matching control characters is the entire point here: they are what a board
  // can inject into a log line. U+061C/U+200E-F/U+202A-E/U+2066-9 are not
  // control characters in the strict sense, but a bidi override reorders
  // everything printed after it, which is the same log-forging trick by other
  // means — this function is the only thing standing between a board's text
  // and the digest.
  return String(s ?? "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Text blob the relevance scorer sees: title + company + location + description.
export function composeText(job, description) {
  return `${job.title}${job.company ? ` at ${job.company}` : ""}. ${job.location}. ${description}`.trim();
}

// Redirects are followed by hand so EVERY hop is checked, not just the URL the
// caller passed: with `redirect: "follow"` an open redirect on a board walks a
// plain GET to any host this Mac can reach, loopback (the state server) included.
// Default policy: stay on the host asked for, its subdomains too.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
function sameSite(url, base) {
  try {
    const a = new URL(url).hostname, b = new URL(base).hostname;
    if (a === b || a.endsWith("." + b)) return true;   // the host itself, or a subdomain of it
    // One step up from the start host — jobs.dou.ua -> dou.ua, which boards do
    // redirect to — and no further. The open-ended `b.endsWith("." + a)` this
    // replaces also accepted "ua" and "co": a redirect from jobs.dou.ua to a
    // host named exactly `ua`, or from djinni.co to `co`, passed the check this
    // function exists to enforce. Requiring a dot in the parent stops that.
    const parent = b.slice(b.indexOf(".") + 1);
    return b.includes(".") && parent.includes(".") && a === parent;
  } catch { return false; }
}
// `allow(url)` vets every hop, the first one included. A hop it rejects throws,
// so the caller's own error path runs and nothing is scored on the response.
export async function fetchFollow(url, init = {}, { allow, max = 5, doFetch = globalThis.fetch } = {}) {
  const start = url;
  const ok = allow || ((u) => sameSite(u, start));
  for (let i = 0; i <= max; i++) {
    if (!ok(url)) throw new Error(`redirect off the allowed host: ${url}`);
    const res = await doFetch(url, { ...init, redirect: "manual" });
    // A stub without headers (tests) or a non-3xx status ends the chain.
    const loc = REDIRECTS.has(res.status) ? res.headers?.get?.("location") : null;
    if (!loc) return res;
    url = new URL(loc, url).toString();
  }
  throw new Error(`too many redirects: ${start}`);
}

// GET a page as text; logs and returns "" on a non-2xx status so callers keep
// their fallback (snippet / skip). Network errors still throw for the caller's
// own error log.
export async function fetchText(url, log, label, doFetch = globalThis.fetch) {
  const res = await fetchFollow(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT) }, { doFetch });
  if (!res.ok) { log(`  ${label} ${res.status}: ${url}`); return ""; }
  return bodyText(res);
}

// A job page is well under 1 MB; a board handing back tens of MB is not a page we
// want to regex. Throws (the caller's own error path) so nothing is scored on it.
const MAX_BODY = 5_000_000;
export async function bodyText(res) {
  const over = () => new Error(`body over ${MAX_BODY} bytes`);
  if (Number(res.headers?.get?.("content-length")) > MAX_BODY) throw over();
  // Stream and stop at the cap, so a chunked body cannot buffer unbounded either;
  // a stub without a stream body (tests) falls back to text(). That branch also
  // honours the charset — text() has already decoded as UTF-8, so re-decode from
  // the bytes when the response says it is something else, instead of leaving
  // one branch of this function outside the contract.
  if (!res.body?.[Symbol.asyncIterator]) {
    const t = await res.text();
    if (t.length > MAX_BODY) throw over();
    const ct = res.headers?.get?.("content-type") || "";
    return /charset=/i.test(ct) && !/charset=["']?utf-?8/i.test(ct) ? decodeBody(Buffer.from(t, "binary"), ct) : t;
  }
  const chunks = []; let n = 0;
  for await (const c of res.body) { if ((n += c.length) > MAX_BODY) throw over(); chunks.push(c); }
  return decodeBody(Buffer.concat(chunks), res.headers?.get?.("content-type"));
}

// Boards are not all UTF-8. A windows-1251 page decoded as UTF-8 becomes
// mojibake, and mojibake is what then gets scored, stored in the package and
// sent to the LLM — with nothing anywhere reporting a problem. Honour the
// Content-Type charset, then the document's own declaration, and fall back to
// UTF-8. TextDecoder covers the legacy single-byte encodings in full-ICU Node;
// an unknown label throws, so it falls back rather than failing the fetch.
export function decodeBody(buf, contentType = "") {
  const head = buf.subarray(0, 2048).toString("latin1");
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    /<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head)?.[1] ||
    "utf-8";
  if (/^utf-?8$/i.test(label)) return buf.toString("utf8");
  try { return new TextDecoder(label).decode(buf); } catch { return buf.toString("utf8"); }
}

// Keep the first record per url (boards repeat a vacancy across searches).
export function uniqueByUrl(jobs) {
  const seen = new Set();
  return jobs.filter((j) => !seen.has(j.url) && seen.add(j.url));
}

// Run `worker` over `items` with at most `limit` in flight at once.
export async function pool(items, limit, worker) {
  let i = 0;
  limit = Math.max(1, Number(limit) || 1);   // "five" or 0 must not silently run zero workers (a hung Promise.all([]) caller)
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}
