// Shared HTML helpers for the job sources (previously copy-pasted in
// dou.mjs, djinni.mjs and jooble.mjs).

export function decodeEntities(s) {
  let out = s || "";
  // Two passes handle double-encoded entities (e.g. "&amp;nbsp;", "&amp;amp;").
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return out;
}

export function stripHtml(s) {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract the inner HTML of the first <div> whose opening tag matches `openRe`,
// counting nested <div>s so the whole block is captured (a non-greedy regex
// would cut nested markup short). Used by djinni.mjs and workua.mjs.
export function extractDiv(html, openRe) {
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
