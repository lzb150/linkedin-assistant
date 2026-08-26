// Minimal frontmatter reader for application packages ("---\nkey: value\n---").
// Returns all keys as an object, or null when the text has no frontmatter.
// (Previously three hand-rolled parsers: dashboard.mjs, followup.mjs, prune-applications.mjs.)
// Frontmatter is line-based: a value with a newline would break parsing or
// inject a fake key. Every value written goes through this at the boundary.
export function fmValue(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

export function parseFrontmatter(md) {
  const m = (md || "").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}
