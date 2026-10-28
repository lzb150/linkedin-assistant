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
      return codePointText(m, parseInt(dec ?? hex, dec ? 10 : 16));
    },
  );
}

// The character a numeric entity `m` names; out of range, `m` stays as written.
function codePointText(m, cp) {
  // NUL and lone surrogates are valid code points but garbage in text.
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  try { return String.fromCodePoint(cp); } catch { return m; }
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
    out += src.slice(i, lt);
    // A comment ends at "-->" whatever it says; "<!-->" closes at once and an
    // unterminated one runs to the end, as in stripBlocks.
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 2);
      if (close === -1) break;
      out += " "; i = close + 3; continue;
    }
    const { end, stop } = tagEnd(src, lt);
    if (end === -1) { out += src.slice(lt, stop); i = stop; }   // unterminated: keep as text
    else { out += " "; i = end + 1; }
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim();
}

// The tag opened at `lt`: `end` is its closing ">" (-1 when it never closes),
// `stop` where the scan stopped (a second "<" or the end of the text).
function tagEnd(src, lt) {
  const element = /[a-zA-Z]/.test(src[lt + 1]);
  let j = lt + 1, prev = "";
  for (; j < src.length; j++) {
    const ch = src[j];
    if (opensValue(element, prev, ch)) {
      // A quoted value is skipped whole: neither ">" nor "<" inside it counts.
      const close = src.indexOf(ch, j + 1);
      // A value still open at the end was never one: the tag ends at its first ">".
      if (close === -1) return { end: src.indexOf(">", lt + 1), stop: src.length };
      j = close; prev = ch; continue;
    }
    if (ch === ">") return { end: j, stop: j };
    if (ch === "<") return { end: -1, stop: j };   // a second "<" first: the token was never a tag
    if (!/\s/.test(ch)) prev = ch;
  }
  return { end: -1, stop: j };
}

// A quote opens a value only right after "=" in an element tag: the
// apostrophe in "<!-- don't -->" or in an unquoted title=don't used to run
// to the end of the text, and the whole rest came out as raw markup.
function opensValue(element, prev, ch) {
  return element && prev === "=" && (ch === '"' || ch === "'");
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
    const end = m[0] === "<!--" ? commentEnd(html, m.index) : elementEnd(html, m);
    i = end;
    opener.lastIndex = end;
  }
  return out + html.slice(i);
}

// Just past the comment opened at `at`.
function commentEnd(html, at) {
  const a = at + 4;
  if (html.startsWith(">", a)) return a + 1;
  if (html.startsWith("->", a)) return a + 2;
  const c = html.indexOf("-->", a);
  return c < 0 ? html.length : c + 3;
}

// Just past the closing tag of the <script>/<style> block `m` opened.
function elementEnd(html, m) {
  const close = new RegExp(/^<script/i.test(m[0]) ? "</script" : "</style", "gi");
  close.lastIndex = m.index;
  const c = close.exec(html);
  if (!c) return html.length;
  const gt = html.indexOf(">", c.index);
  return gt < 0 ? html.length : gt + 1;
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
// A board's "posted" stamp → ISO string, or undefined when it is missing,
// unparseable or absurd (before 2000, or more than a day ahead — clock skew is
// real, a 2099 is a parser bug). Accepts RFC 2822 (RSS pubDate), ISO,
// unix seconds (Himalayas) and Djinni's "HH:MM DD.MM.YYYY" tooltip (Kyiv time).
export function isoDate(v, now = Date.now()) {
  let t;
  if (typeof v === "number") t = v < 1e11 ? v * 1000 : v;   // seconds vs ms
  else if (typeof v === "string") {
    const s = v.trim();
    const dj = /^(\d{2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    t = dj ? Date.parse(`${dj[5]}-${dj[4]}-${dj[3]}T${dj[1]}:${dj[2]}:00+02:00`) : Date.parse(s);
  }
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now + 86_400_000) return undefined;
  return new Date(t).toISOString();
}

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
    const ua = new URL(url), ub = new URL(base);
    return sameService(ua, ub) && sameHost(ua.hostname, ub.hostname);
  } catch { return false; }
}

// Scheme and port of the hop `ua` against the start URL `ub`.
function sameService(ua, ub) {
  // Scheme first: pinning the hostname alone let a board (or anyone on-path)
  // answer 301 with http://same.host/… and walk the rest of the chain in
  // cleartext. lib/closed.mjs onBoardHost already checks the protocol; these
  // two allow-policies now agree.
  if (!/^https?:$/.test(ua.protocol)) return false;                          // never file:, data:, ftp:
  if (ub.protocol === "https:" && ua.protocol !== "https:") return false;    // no downgrade (upgrade is fine)
  // Same port too: a hop to https://host:8443 is another service on that
  // machine, which tgchannels.mjs isPublicHttps already refuses on the apply
  // link itself. The parser drops a default port, so "" matches ":443".
  return ua.port === ub.port;
}

// Hostname `a` against the start host `b`.
function sameHost(a, b) {
  if (a === b || a.endsWith("." + b)) return true;   // the host itself, or a subdomain of it
  // One step up from the start host — jobs.dou.ua -> dou.ua, which boards do
  // redirect to — and no further. The open-ended `b.endsWith("." + a)` this
  // replaces also accepted "ua" and "co": a redirect from jobs.dou.ua to a
  // host named exactly `ua`, or from djinni.co to `co`, passed the check this
  // function exists to enforce. Requiring a dot in the parent stops that.
  const parent = b.slice(b.indexOf(".") + 1);
  return b.includes(".") && parent.includes(".") && a === parent;
}
// A body nobody reads still holds its socket until GC: cancel it so a run of
// redirects or error statuses does not pile up open connections.
export async function discardBody(res) {
  try { await res.body?.cancel(); } catch {}
}
// A response header; undefined on a stub without headers (tests).
function header(res, name) {
  return res.headers?.get?.(name);
}
// `allow(url)` vets every hop, the first one included. A hop it rejects throws,
// so the caller's own error path runs and nothing is scored on the response.
// `stopAt(url)` marks a redirect target that is an answer in itself — "no such
// page" — rather than an error: the chain ends there and null is returned.
export async function fetchFollow(url, init = {}, { allow, stopAt, max = 5, doFetch = globalThis.fetch } = {}) {
  const start = url;
  const ok = allow || ((u) => sameSite(u, start));
  for (let i = 0; i <= max; i++) {
    if (!ok(url)) throw new Error(`redirect off the allowed host: ${url}`);
    const res = await doFetch(url, { ...init, redirect: "manual" });
    // A stub without headers (tests) or a non-3xx status ends the chain.
    const loc = REDIRECTS.has(res.status) ? header(res, "location") : null;
    if (!loc) return res;
    await discardBody(res);
    url = new URL(loc, url).toString();
    if (stopAt?.(url)) return null;
  }
  throw new Error(`too many redirects: ${start}`);
}

// GET a page as text; logs and returns "" on a non-2xx status so callers keep
// their fallback (snippet / skip). Network errors still throw for the caller's
// own error log. null = a redirect `stopAt` recognised (see fetchFollow).
export async function fetchText(url, log, label, { doFetch = globalThis.fetch, stopAt } = {}) {
  const res = await fetchFollow(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT) }, { doFetch, stopAt });
  if (res === null) return null;
  if (!res.ok) { log(`  ${label} ${res.status}: ${url}`); await discardBody(res); return ""; }
  return bodyText(res);
}

// A job page is well under 1 MB; a board handing back tens of MB is not a page we
// want to regex. Throws (the caller's own error path) so nothing is scored on it.
const MAX_BODY = 5_000_000;
const over = () => new Error(`body over ${MAX_BODY} bytes`);
export async function bodyText(res) {
  if (Number(header(res, "content-length")) > MAX_BODY) throw over();
  // Stream and stop at the cap, so a chunked body cannot buffer unbounded either;
  // a stub without a stream body (tests) falls back below.
  if (!res.body?.[Symbol.asyncIterator]) return wholeBody(res);
  const chunks = []; let n = 0;
  for await (const c of res.body) { if ((n += c.length) > MAX_BODY) throw over(); chunks.push(c); }
  return decodeBody(Buffer.concat(chunks), header(res, "content-type"));
}

// A body without a stream, read in one go. Prefer the raw bytes, so this
// branch honours the charset like the streamed one. The re-decode it replaces
// could not work: res.text() has ALREADY decoded as UTF-8, and
// Buffer.from(thatText, "binary") maps every U+FFFD it produced to 0x3F —
// "Привіт" in cp1251 came back as "эээээ". Bytes, or nothing: a stub with no
// arrayBuffer() gets text() as-is rather than a corrupted re-decode.
async function wholeBody(res) {
  if (typeof res.arrayBuffer === "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY) throw over();
    return decodeBody(buf, header(res, "content-type"));
  }
  const t = await res.text();
  if (t.length > MAX_BODY) throw over();
  return t;
}

// Boards are not all UTF-8. A windows-1251 page decoded as UTF-8 becomes
// mojibake, and mojibake is what then gets scored, stored in the package and
// sent to the LLM — with nothing anywhere reporting a problem. Honour the
// Content-Type charset, then the document's own declaration, and fall back to
// UTF-8. TextDecoder covers the legacy single-byte encodings in full-ICU Node;
// an unknown label throws, so it falls back rather than failing the fetch.
export function decodeBody(buf, contentType = "") {
  const label = charsetOf(contentType, buf.subarray(0, 2048).toString("latin1"));
  if (/^utf-?8$/i.test(label)) return buf.toString("utf8");
  try { return new TextDecoder(label).decode(buf); } catch { return buf.toString("utf8"); }
}

// The charset label: the header's, else the document head's <meta> or <?xml>.
function charsetOf(contentType, head) {
  return /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    /<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head)?.[1] ||
    "utf-8";
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

// pool() for sources that replay their results in config order: each worker
// gets its own `say(line)` and returns its items; once the pool drains, the
// lines are logged and the items concatenated in input order — so the returned
// list and the log read exactly as a sequential loop would, which matters
// because jobs.mjs spends its LLM budget (llm.maxPerRun) in list order.
export async function orderedPool(items, limit, worker, log) {
  const results = items.map(() => []);
  const lines = items.map(() => []);
  await pool(items.map((_, i) => i), limit, async (i) => {
    results[i] = (await worker(items[i], (line) => lines[i].push(line))) || [];
  });
  for (const line of lines.flat()) log(line);
  return results.flat();
}

// The paged-search loop every board shares (Djinni, Himalayas, Telegram):
// the searches run through orderedPool, the pages WITHIN one search stay
// sequential (page p+1 is only worth fetching when page p came back), and the
// source supplies `page(search, p, say, prev)`, which reads one page and answers
//   { items, more, … }  a page read; `more: false` ends the search after it, and
//                       the answer comes back as `prev` for the next page (a cursor)
//   { cut: reason }     a page that failed — the search is partial, and says so
//   null                past the last page — the search ends quietly
// One "<label> ok|partial (N over P pages): <name>" line per search, and every
// search failing before its first page is an outage, thrown rather than logged.
// `unit` names the items in that line ("job" → "2 jobs"); `plural` is the
// outage's noun ("Djinni search(es)").
export async function pagedSearch(searches, { limit, pages, label, plural, name = String, unit = "", page }, log) {
  let failed = 0;   // searches that never got their first page
  const found = await orderedPool(searches, limit, async (search, say) => {
    // read = pages, not items: a first page of ads only (0 jobs) was still read
    const got = { jobs: [], read: 0 };
    try {
      const cut = await readPages(search, pages, page, say, got);
      if (cut && !got.read) failed++;   // cut at page 1
      say(`  ${label} ${cut ? "partial" : "ok"} (${counted(got.jobs.length, unit)} over ${counted(got.read, "page")}): ${name(search)}${cut}`);
    } catch (e) {
      say(`  ${label} error: ${name(search)} — ${e.message}`);
      if (!got.read) failed++;
    }
    return got.jobs;
  }, log);
  if (searches.length && failed === searches.length) throw new Error(`all ${failed} ${plural} failed`);
  return uniqueByUrl(found);
}

// One search's pages in order, into `got` as each one is read, so a page that
// throws still leaves the ones before it. Answers the cut note ("" = none).
async function readPages(search, pages, page, say, got) {
  let prev = null;
  for (let p = 1; p <= pages; p++) {
    const r = await page(search, p, say, prev);
    if (!r) break;
    if (r.cut) return ` — stopped at page ${p}: ${r.cut}`;
    got.jobs.push(...r.items); got.read++;
    if (r.more === false) break;
    prev = r;
  }
  return "";
}

// "2 jobs" / "1 job"; the bare number when there is no unit.
function counted(n, unit) {
  return unit ? `${n} ${unit}${n === 1 ? "" : "s"}` : String(n);
}

// A job page's description as text, or "" on any failure — the caller keeps
// the listing text as its fallback.
async function fetchDescription(url, log, label, extract, doFetch) {
  try {
    const html = await fetchText(url, log, `  ${label}`, { doFetch });
    return html ? extract(html) : "";
  } catch (e) {
    log(`    ${label} error: ${url} — ${e.message}`);
    return "";
  }
}

// Full descriptions for the jobs the caller does not already know (`skip`):
// the known ones keep their listing text, so the seen store still re-stamps
// them. `url(job)` is the page to fetch (falsy = nothing to fetch), `extract`
// turns its HTML into text and `text(job, full)` is the record's new text.
// `fetching(n, known)` / `enriched(ok, n)` word the two log lines. Bounded
// concurrency keeps it polite while staying much faster than one-at-a-time.
export async function enrich(jobs, { label, fetching, enriched, skip = () => false, limit, url, extract, text, doFetch }, log) {
  const toEnrich = jobs.filter((job) => url(job) && !skip(job));
  if (!toEnrich.length) return;
  log(fetching(toEnrich.length, jobs.length - toEnrich.length));
  let ok = 0;
  await pool(toEnrich, limit, async (job) => {
    const full = await fetchDescription(url(job), log, label, extract, doFetch);
    if (full) { job.text = text(job, full); ok++; }
  });
  log(enriched(ok, toEnrich.length));
}
