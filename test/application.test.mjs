import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApplication } from "../lib/application.mjs";

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
