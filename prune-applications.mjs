// Prune stale duplicate application packages in applications/.
//
// applications/ is append-only, so historical runs left many packages for the
// same vacancy (e.g. a Jooble job whose URL changed every run back when seen
// was URL-keyed). The dashboard already collapses these at render time; this
// script reclaims the disk clutter by keeping only the newest package per
// identity (company+title) and deleting the rest.
//
// It also moves packages of vacancies that closed-check.mjs marked "closed"
// 14+ days ago (--closed-days N to change; 0 = every closed one) into
// applications/archive/, which no script reads — the dashboard gets lighter.
//
// Run:  node prune-applications.mjs                 (dry run — shows what would go)
//       node prune-applications.mjs --apply         (delete duplicates, archive closed)
//       node prune-applications.mjs --closed-days 0 --apply

import { readdirSync, readFileSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { identityKey } from "./lib/dedup.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { readStoreOrExit, statusOf } from "./lib/job-state.mjs";
import { planArchive } from "./lib/closed.mjs";

/**
 * Decide which package files to keep and which to remove.
 * Groups by identityKey — the same strict key the dashboard collapses on, so
 * prune never deletes a card the dashboard still shows separately — and keeps the most recently `generated` package per group; ties are broken
 * deterministically by the larger filename. Packages with a status other than
 * "new" (viewed/applied/...) are never removed.
 * @param {{file:string, company:string, title:string, generated:string, status?:string}[]} packages
 * @returns {{ keep: string[], remove: string[] }}
 */
export function planPrune(packages) {
  const tracked = (p) => Boolean(p.status && p.status !== "new"); // viewed/applied/… → always keep
  const best = new Map();
  for (const p of packages) {
    if (tracked(p)) continue;
    const key = identityKey({ company: p.company, title: p.title, url: p.url }); // url scopes blank companies
    const cur = best.get(key);
    if (!cur) { best.set(key, p); continue; }
    const g = p.generated || "", cg = cur.generated || "";
    if (g > cg || (g === cg && p.file > cur.file)) best.set(key, p);
  }
  const keepSet = new Set([...best.values()].map((p) => p.file));
  const keep = [], remove = [];
  for (const p of packages) (tracked(p) || keepSet.has(p.file) ? keep : remove).push(p.file);
  return { keep, remove };
}

// CLI: only runs when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes("--apply");
  const ROOT = dirname(fileURLToPath(import.meta.url));
  const APPS = join(ROOT, "applications");
  mkdirSync(APPS, { recursive: true }); // fresh clone: nothing to prune, but don't crash
  const state = readStoreOrExit(join(ROOT, "job-state.json"), "refusing to prune against unknown statuses");
  const files = readdirSync(APPS).filter((f) => f.endsWith(".md"));
  const packages = files.map((f) => {
    const fm = parseFrontmatter(readFileSync(join(APPS, f), "utf8")) || {};
    return { file: f, company: fm.company || "", title: fm.title || "", url: fm.url || "", generated: fm.generated || "", status: statusOf(state, fm.url) };
  });

  const { keep, remove } = planPrune(packages);
  const cdIdx = process.argv.indexOf("--closed-days");
  const closedDays = cdIdx !== -1 && Number.isFinite(Number(process.argv[cdIdx + 1])) ? Number(process.argv[cdIdx + 1]) : 14;
  const removeSet = new Set(remove);
  const archive = planArchive({ packages, stateMap: state, closedDays }).filter((f) => !removeSet.has(f));
  console.log(`${files.length} package(s): keep ${keep.length - archive.length}, remove ${remove.length}, archive ${archive.length} (closed ${closedDays}+ days)`);
  if (!remove.length && !archive.length) { console.log("Nothing to prune."); process.exit(0); }

  if (!apply) {
    console.log("\n--- DRY RUN (nothing changed). Re-run with --apply: ---");
    for (const f of remove) console.log(`  would remove   ${f}`);
    for (const f of archive) console.log(`  would archive  ${f}`);
    console.log(`\n${remove.length} file(s) would be removed, ${archive.length} archived. Run: node prune-applications.mjs --apply`);
    process.exit(0);
  }

  for (const f of remove) unlinkSync(join(APPS, f));
  if (archive.length) mkdirSync(join(APPS, "archive"), { recursive: true });
  for (const f of archive) renameSync(join(APPS, f), join(APPS, "archive", f));
  console.log(`Removed ${remove.length} stale duplicate package(s), archived ${archive.length}. ${keep.length - archive.length} remain.`);
}
