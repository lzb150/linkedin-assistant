// Prune stale duplicate application packages in applications/.
//
// applications/ is append-only, so historical runs left many packages for the
// same vacancy (e.g. a Jooble job whose URL changed every run back when seen
// was URL-keyed). The dashboard already collapses these at render time; this
// script reclaims the disk clutter by keeping only the newest package per
// identity (company+title) and deleting the rest.
//
// Run:  node prune-applications.mjs           (dry run — shows what would go)
//       node prune-applications.mjs --apply   (actually delete)

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { identityKey } from "./lib/dedup.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";

/**
 * Decide which package files to keep and which to remove.
 * Keeps the most recently `generated` package per identity (company+title);
 * ties are broken deterministically by the larger filename.
 * @param {{file:string, company:string, title:string, generated:string}[]} packages
 * @returns {{ keep: string[], remove: string[] }}
 */
export function planPrune(packages) {
  const best = new Map();
  for (const p of packages) {
    const key = identityKey({ company: p.company, title: p.title });
    const cur = best.get(key);
    if (!cur) { best.set(key, p); continue; }
    const g = p.generated || "", cg = cur.generated || "";
    if (g > cg || (g === cg && p.file > cur.file)) best.set(key, p);
  }
  const keepSet = new Set([...best.values()].map((p) => p.file));
  const keep = [], remove = [];
  for (const p of packages) (keepSet.has(p.file) ? keep : remove).push(p.file);
  return { keep, remove };
}

// CLI: only runs when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes("--apply");
  const APPS = join(dirname(fileURLToPath(import.meta.url)), "applications");
  const files = readdirSync(APPS).filter((f) => f.endsWith(".md"));
  const packages = files.map((f) => {
    const fm = parseFrontmatter(readFileSync(join(APPS, f), "utf8")) || {};
    return { file: f, company: fm.company || "", title: fm.title || "", generated: fm.generated || "" };
  });

  const { keep, remove } = planPrune(packages);
  console.log(`${files.length} package(s): keep ${keep.length}, remove ${remove.length}`);
  if (!remove.length) { console.log("Nothing to prune."); process.exit(0); }

  if (!apply) {
    console.log("\n--- DRY RUN (no files deleted). Re-run with --apply to delete: ---");
    for (const f of remove) console.log(`  would remove  ${f}`);
    console.log(`\n${remove.length} file(s) would be removed. Run: node prune-applications.mjs --apply`);
    process.exit(0);
  }

  for (const f of remove) unlinkSync(join(APPS, f));
  console.log(`Removed ${remove.length} stale duplicate package(s). ${keep.length} remain.`);
}
