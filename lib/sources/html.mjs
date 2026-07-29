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
