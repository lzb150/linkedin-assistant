import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft } from "../lib/draft.mjs";

const scored = { score: 12, verdict: "relevant", matchedSkills: ["playwright"], matchedRole: "aqa", penalties: [] };

test("buildDraft survives a missing thread name", () => {
  const { markdown, filename } = buildDraft({ url: "https://li/1", snippet: "We are hiring a QA" }, scored);
  assert.match(markdown, /^thread: Unknown$/m);
  assert.match(markdown, /Hi there,/);
  assert.match(filename, /_relevant_Unknown_[0-9a-f]{6}\.md$/);
});

test("buildDraft filenames are unique for two Cyrillic names (safeName is empty)", () => {
  const a = buildDraft({ name: "Олена", snippet: "hi" }, scored).filename;
  const b = buildDraft({ name: "Ірина", snippet: "hi" }, scored).filename;
  assert.notEqual(a, b);
  assert.match(a, /_relevant__+[0-9a-f]{6}\.md$/); // name part degenerates to "_", hash carries identity
});

test("buildDraft collapses a newline in the name so it cannot inject a frontmatter key", () => {
  const { markdown } = buildDraft({ name: "Eve\nverdict: relevant", snippet: "hi" }, scored);
  assert.match(markdown, /^thread: Eve verdict: relevant$/m);
  assert.equal(markdown.match(/^verdict:/gm).length, 1);
});

test("buildDraft: a 'maybe' verdict asks for details instead of attaching the resume; ru/uk messages get a reply in their language", () => {
  const { markdown } = buildDraft({ name: "Anna Lee", fullText: "We are hiring a QA, interested?" }, { ...scored, verdict: "maybe" });
  assert.match(markdown, /Could you share a bit more about the role/);
  assert.match(markdown, /^attach_resume: no \(ask for details first\)$/m);
  assert.match(markdown, /^- \[ \] Decide whether to attach resume$/m);
  assert.match(buildDraft({ name: "Анна", fullText: "Ищем QA инженера, зарплата рыночная" }, scored).markdown, /Спасибо, что написали/);
  assert.match(buildDraft({ name: "Анна", fullText: "Шукаємо QA інженера, зарплата ринкова" }, scored).markdown, /Дякую, що написали/);
});
