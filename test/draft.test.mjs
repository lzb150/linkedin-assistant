import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft } from "../lib/draft.mjs";

const scored = { score: 12, verdict: "relevant", matchedSkills: ["playwright"], matchedRole: "aqa", penalties: [] };

test("buildDraft survives a missing thread name", () => {
  const { markdown, filename } = buildDraft({ url: "https://li/1", snippet: "We are hiring a QA" }, scored);
  assert.match(markdown, /^thread: Unknown$/m);
  assert.match(markdown, /Hi there,/);
  assert.match(filename, /_relevant_Unknown\.md$/);
});

test("buildDraft collapses a newline in the name so it cannot inject a frontmatter key", () => {
  const { markdown } = buildDraft({ name: "Eve\nverdict: relevant", snippet: "hi" }, scored);
  assert.match(markdown, /^thread: Eve verdict: relevant$/m);
  assert.equal(markdown.match(/^verdict:/gm).length, 1);
});
