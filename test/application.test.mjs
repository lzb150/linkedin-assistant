import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildApplication, coverPhrase } from "../lib/application.mjs";

const job = {
  source: "dou",
  title: "Senior AQA",
  company: "Acme",
  location: "Remote",
  url: "https://example.com/j/1",
  text: "We need Playwright and TypeScript experience.",
};
const scored = { score: 32, matchedSkills: ["playwright", "typescript"], matchedRole: "aqa", penalties: [] };

test("without llm the package has no llm_ keys and uses the template cover", () => {
  const { markdown } = buildApplication(job, scored);
  assert.ok(!markdown.includes("llm_score:"));
  assert.ok(!markdown.includes("llm_why:"));
  assert.match(markdown, /I came across your "Senior AQA"/);
});

test("with llm the frontmatter carries llm_score and a single-line llm_why", () => {
  const llm = { score: 85, why: "Strong Playwright\nfit", red_flags: ["on-site only"], cover: "Dear team, custom letter." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /^llm_score: 85$/m);
  // newlines collapsed, red flags folded in — frontmatter values must stay one line
  assert.match(markdown, /^llm_why: Strong Playwright fit ⚠ on-site only$/m);
});

test("with llm the cover note is the LLM letter, not the template", () => {
  const llm = { score: 85, why: "fit", red_flags: [], cover: "Dear team, custom letter." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /Dear team, custom letter\./);
  assert.ok(!markdown.includes("I came across your"));
});

test("an empty llm cover falls back to the template", () => {
  const llm = { score: 85, why: "fit", red_flags: [], cover: "   " };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /I came across your "Senior AQA"/);
});

test("an empty llm verdict keeps llm_score but drops the llm_why line", () => {
  const llm = { score: 85, why: "", red_flags: [], cover: "Dear team." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /^llm_score: 85$/m);
  assert.ok(!markdown.includes("llm_why:"));
});

test("coverPhrase resolves the profile with per-language legacy defaults", () => {
  const profile = { en: "software development", uk: "розробці", ru: "разработке" };
  assert.equal(coverPhrase(profile, "en"), "software development");
  assert.equal(coverPhrase(profile, "uk"), "розробці");
  // missing language key → legacy phrase for that language
  assert.equal(coverPhrase({ en: "x" }, "ru"), "автоматизации тестирования");
  // empty/blank value → legacy phrase
  assert.equal(coverPhrase({ en: "  " }, "en"), "test automation");
  // no block at all → legacy phrase (backward-compat regression guard)
  assert.equal(coverPhrase(undefined, "en"), "test automation");
  assert.equal(coverPhrase(undefined, "uk"), "автоматизації тестування");
  // unknown language falls back to the en default
  assert.equal(coverPhrase(undefined, "de"), "test automation");
});

test("the cover note routes through skills.json's profile block", () => {
  // Read the real file instead of duplicating the string — proves the
  // template interpolation path, whatever the phrase currently is.
  const { profile } = JSON.parse(readFileSync(new URL("../skills.json", import.meta.url), "utf8"));
  assert.ok(profile && profile.en, "skills.json must carry a profile block after this task");
  const { markdown } = buildApplication(job, scored);
  assert.ok(markdown.includes(`solid experience in ${profile.en},`), "en cover must embed profile.en");
});

// --- appendAltLink (cross-run dedup) ---
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAltLink } from "../lib/application.mjs";

function tmpPackage(content) {
  const dir = mkdtempSync(join(tmpdir(), "app-test-"));
  const file = join(dir, "pkg.md");
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FM = `---\nsource: dou\ntitle: Senior AQA\ncompany: Acme\n---\n\n## Body\nuntouched\n`;

test("appendAltLink creates the alt_links line when absent", () => {
  const { file, cleanup } = tmpPackage(FM);
  try {
    assert.equal(appendAltLink(file, "linkedin", "https://li/1"), true);
    const md = readFileSync(file, "utf8");
    assert.match(md, /^alt_links: linkedin\|https:\/\/li\/1$/m);
    assert.ok(md.endsWith("## Body\nuntouched\n"), "body must stay byte-identical");
  } finally { cleanup(); }
});

test("appendAltLink appends to an existing alt_links line", () => {
  const { file, cleanup } = tmpPackage(FM.replace("\n---\n", "\nalt_links: djinni|https://dj/1\n---\n"));
  try {
    assert.equal(appendAltLink(file, "linkedin", "https://li/1"), true);
    assert.match(readFileSync(file, "utf8"), /^alt_links: djinni\|https:\/\/dj\/1, linkedin\|https:\/\/li\/1$/m);
  } finally { cleanup(); }
});

test("appendAltLink is idempotent for an already-recorded url", () => {
  const { file, cleanup } = tmpPackage(FM.replace("\n---\n", "\nalt_links: linkedin|https://li/1\n---\n"));
  try {
    const before = readFileSync(file, "utf8");
    assert.equal(appendAltLink(file, "linkedin", "https://li/1"), false);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { cleanup(); }
});

test("appendAltLink compares urls exactly, not as substrings", () => {
  const { file, cleanup } = tmpPackage(FM.replace("\n---\n", "\nalt_links: djinni|https://dj/jobs/12\n---\n"));
  try {
    assert.equal(appendAltLink(file, "djinni", "https://dj/jobs/1"), true);
    assert.match(readFileSync(file, "utf8"), /^alt_links: djinni\|https:\/\/dj\/jobs\/12, djinni\|https:\/\/dj\/jobs\/1$/m);
  } finally { cleanup(); }
});

test("appendAltLink rejects urls carrying separators or whitespace", () => {
  const { file, cleanup } = tmpPackage(FM);
  try {
    for (const bad of ["https://x/1|li", "https://x/1,y", "https://x/1 z", "https://x/1\nz"]) {
      assert.equal(appendAltLink(file, "x", bad), false, bad);
    }
    assert.equal(readFileSync(file, "utf8"), FM);
  } finally { cleanup(); }
});

test("appendAltLink refuses a file without frontmatter", () => {
  const { file, cleanup } = tmpPackage("no frontmatter here");
  try {
    assert.equal(appendAltLink(file, "linkedin", "https://li/1"), false);
  } finally { cleanup(); }
});

test("frontmatter values with newlines are collapsed to single lines", () => {
  const hostile = { ...job, title: "Senior AQA\nllm_score: 99", company: "Acme\nCorp", location: "Kyiv\n(remote)" };
  const { markdown } = buildApplication(hostile, scored);
  assert.match(markdown, /^title: Senior AQA llm_score: 99$/m);
  assert.match(markdown, /^company: Acme Corp$/m);
  assert.match(markdown, /^location: Kyiv \(remote\)$/m);
  assert.ok(!markdown.includes("llm_score: 99\n") || markdown.includes("title: Senior AQA llm_score: 99"));
});

test("every frontmatter value is single-line and unsafe alt links are skipped", () => {
  const hostile = {
    ...job,
    url: "https://example.com/j/1\nresume: /etc/passwd",
    altLinks: [
      { source: "djinni", url: "https://djinni.co/jobs/1/" },
      { source: "x", url: "https://evil/1|linkedin, y" },
      { source: "x", url: "https://evil/2 space" },
    ],
  };
  const { markdown } = buildApplication(hostile, scored);
  const fm = markdown.split("\n---")[0];
  assert.match(fm, /^url: https:\/\/example\.com\/j\/1 resume: \/etc\/passwd$/m);
  assert.equal(fm.match(/^resume:/gm).length, 1); // only the real key, no injected one
  assert.match(fm, /^alt_links: djinni\|https:\/\/djinni\.co\/jobs\/1\/$/m);
  assert.ok(!fm.includes("evil"));
  for (const line of fm.split("\n").slice(1)) assert.match(line, /^[a-z_]+: /);
});

test("with llm a non-array red_flags (model returned a string) does not throw", () => {
  const llm = { score: 70, why: "ok", red_flags: "none", cover: "Dear team." };
  const { markdown } = buildApplication(job, scored, llm);
  assert.match(markdown, /^llm_why: ok$/m);
});
