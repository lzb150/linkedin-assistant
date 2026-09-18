// Generate skills.json from your resume, in one command.
//
// Run:  node make-skills.mjs                 (reads resume.txt, writes skills.json)
//       node make-skills.mjs --force         (overwrite an existing skills.json)
//       node make-skills.mjs --resume cv.txt --out skills.json
//       node make-skills.mjs --print         (show the profile, write nothing)
//
// The keyword profile is the first gate every vacancy passes, and it is the one
// setup step that cannot be copied from an example: ship a QA profile to a
// backend developer and the tool works perfectly, on somebody else's vacancies.
// This drafts it from the resume with the same sandboxed local CLI the screener
// uses, normalizes the answer, and leaves it for you to edit.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { llmJSON } from "./lib/llm.mjs";
import { writeTextAtomic } from "./lib/json-file.mjs";
import { buildSkillsPrompt, normalizeProfile, profileIsUsable, serializeProfile } from "./lib/skills-profile.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

if (flag("help")) {
  console.log("node make-skills.mjs [--resume resume.txt] [--out skills.json] [--model sonnet] [--force] [--print]");
  process.exit(0);
}

const resumeFile = join(__dir, opt("resume", "resume.txt"));
const outFile = join(__dir, opt("out", "skills.json"));
const model = opt("model", "sonnet");
const write = !flag("print");

if (!existsSync(resumeFile)) {
  console.error(`✋ ${basename(resumeFile)} not found. Put your resume there as plain text first — it is what the profile is built from.`);
  process.exit(1);
}
const resume = readFileSync(resumeFile, "utf8").trim();
if (resume.length < 200) {
  console.error(`✋ ${basename(resumeFile)} is only ${resume.length} characters. That is too little to build a profile from; paste the full resume text.`);
  process.exit(1);
}
// Overwriting is the destructive case: the file is meant to be hand-edited
// after generation, so a second run must not silently discard that work.
if (write && existsSync(outFile) && !flag("force")) {
  console.error(`✋ ${basename(outFile)} already exists. Re-run with --force to replace it (your edits there would be lost), or --print to preview.`);
  process.exit(1);
}

console.log(`Reading ${basename(resumeFile)} (${resume.length} chars) and asking ${model} for a profile...`);
const raw = await llmJSON(buildSkillsPrompt(resume), { model, log: (m) => console.log(m) });
if (!raw) {
  console.error("✋ The local `claude` CLI returned nothing usable. Check it runs (`claude -p hello`) and try again.");
  process.exit(1);
}

const profile = normalizeProfile(raw);
const problems = profileIsUsable(profile);
if (problems.length) {
  console.error(`✋ The generated profile is too thin to screen with (${problems.join("; ")}). Re-run, or start from skills.developer.json.example.`);
  process.exit(1);
}

const json = serializeProfile(profile, { resumeName: basename(resumeFile) });
const top = Object.entries(profile.skills).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, w]) => `${s} (${w})`);
console.log(`\n${profile.roles.length} roles · ${Object.keys(profile.skills).length} skills · ${Object.keys(profile.antiKeywords).length} anti-keywords`);
console.log(`Top skills: ${top.join(", ")}`);
console.log(`Roles: ${profile.roles.slice(0, 6).join(", ")}${profile.roles.length > 6 ? ", …" : ""}`);
console.log(`Specialization: ${profile.profile.en}`);

if (!write) { console.log(`\n${json}`); process.exit(0); }
writeTextAtomic(outFile, json);
console.log(`\n✅ Wrote ${basename(outFile)}. Read it once and adjust the weights — then point jobs.config.json's feeds and searches at your own field.`);
