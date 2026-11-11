import { test } from "node:test";
import assert from "node:assert/strict";
import { fullstackStackExcluder } from "../lib/fullstack-stack.mjs";
import { keywordGate } from "../lib/keyword-gate.mjs";

const TERMS = ["java", "php", "python", "golang", "Go"];
const excludes = fullstackStackExcluder(TERMS);
const fullstack = (text, title = "Senior Fullstack Engineer") => excludes({ title, text: `${title} at Acme. Remote. ${text}` });

test("a fullstack role naming Java, PHP, Python or Go is excluded, whichever way it is spelt", () => {
  assert.equal(fullstack("Requirements: 5 years of Java and Spring."), "java");
  assert.equal(fullstack("Backend in PHP / Laravel."), "php");
  assert.equal(fullstack("We use React and Python (FastAPI)."), "python");
  assert.equal(fullstack("Node.js or Golang services."), "golang");
  assert.equal(fullstack("Experience with Go, Kubernetes and React."), "Go");
  assert.equal(fullstack("PYTHON3 and Django"), "python", "case-insensitive, a digit may follow");
  assert.equal(fullstack("Java8 legacy modules"), "java");
});

test("the language may sit in the title alone", () => {
  assert.equal(excludes({ title: "Full-Stack Developer (Python)", text: "short" }), "python");
  assert.equal(excludes({ title: "Фулстек розробник (PHP)", text: "short" }), "php");
});

test("fullstack is recognised in every spelling, Cyrillic included", () => {
  for (const title of ["Full Stack Engineer", "Full-Stack Engineer", "Fullstack Developer", "FULLSTACK Dev", "Фулстек розробник", "Фуллстек разработчик", "Фул-стек розробник"]) {
    assert.equal(excludes({ title, text: "Python required" }), "python", title);
  }
});

test("only fullstack roles are judged: frontend and Node.js-only roles keep a mentioned language", () => {
  assert.equal(excludes({ title: "Senior Frontend Engineer", text: "Our backend is Python; you will only touch React." }), undefined);
  assert.equal(excludes({ title: "Node.js Developer", text: "Some Java services exist." }), undefined);
});

test("a fullstack role without any of them is kept", () => {
  assert.equal(fullstack("React, Next.js, Node.js, NestJS, PostgreSQL, TypeScript, Docker."), undefined);
});

test("JavaScript is not Java, and a longer word is not a language", () => {
  assert.equal(fullstack("JavaScript and TypeScript everywhere. Experience with PHPStorm is a plus."), undefined);
  assert.equal(fullstack("We are a Gopher-friendly, pythonic-minded team."), undefined, "Gopher / pythonic are other words");
});

test("'Go' is the language only when written as one", () => {
  assert.equal(fullstack("We go the extra mile and let the team go home early."), undefined, "lowercase verb");
  assert.equal(fullstack("Go beyond what is asked. React and Node.js."), undefined, "a sentence opening with the verb");
  assert.equal(fullstack("Great team.\nGo beyond what is asked."), undefined, "a line opening with the verb");
  assert.equal(fullstack("Great team.\n- Go, Rust or Node.js"), "Go", "a bullet naming the language");
  assert.equal(fullstack("Great team.\n- Go (Golang) experience"), "golang", "excluded either way; the unambiguous term is listed first");
  assert.equal(fullstack("Strong React. Go developers welcome."), undefined, "known trade-off: an opening 'Go developers' reads as the verb");
});

test("a folded copy's title counts as the fullstack title", () => {
  const j = { title: "Software Engineer", mergedTitles: ["Full Stack Engineer"], text: "Software Engineer at Acme. We run Python workers." };
  assert.equal(excludes(j), "python");
});

test("an empty or missing list switches the rule off", () => {
  assert.equal(fullstackStackExcluder([])({ title: "Fullstack", text: "Python" }), undefined);
  assert.equal(fullstackStackExcluder(undefined)({ title: "Fullstack", text: "Python" }), undefined);
  assert.equal(fullstackStackExcluder(["  ", ""])({ title: "Fullstack", text: "Python" }), undefined, "blank terms are ignored");
});

test("keywordGate drops it as excluded before scoring, with the language in the term", () => {
  const job = { source: "djinni", title: "Fullstack Developer", company: "Acme", url: "https://djinni.co/jobs/1/", text: `Fullstack Developer at Acme. Remote. ${"React Node.js ".repeat(40)} Python is required.` };
  const opts = {
    seen: new Set(), packageIndex: new Map(), excludedByTitle: () => undefined, excludedByStack: excludes,
    minScore: 18, requireRole: true, score: () => assert.fail("an excluded job must not be scored"),
  };
  const g = keywordGate(job, opts);
  assert.equal(g.kind, "excluded");
  assert.equal(g.term, "fullstack+python");
  assert.ok(g.considered, "new to the run, so it is counted and stamped seen");
  const clean = keywordGate({ ...job, text: job.text.replace("Python", "TypeScript") }, { ...opts, score: () => ({ score: 30, matchedRole: "fullstack developer" }) });
  assert.equal(clean.kind, "match");
});
