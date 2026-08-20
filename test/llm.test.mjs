import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON, llmJSON, buildJobPrompt } from "../lib/llm.mjs";

test("extractJSON parses a clean JSON object", () => {
  assert.deepEqual(extractJSON('{"score":80}'), { score: 80 });
});

test("extractJSON pulls JSON out of surrounding prose", () => {
  assert.deepEqual(
    extractJSON('Sure! Here it is:\n{"score":55,"why":"ok"}\n'),
    { score: 55, why: "ok" },
  );
});

test("extractJSON returns null on missing or broken JSON", () => {
  assert.equal(extractJSON("no json here"), null);
  assert.equal(extractJSON('{"score": }'), null);
  assert.equal(extractJSON(""), null);
  assert.equal(extractJSON(null), null);
});

test("llmJSON resolves parsed JSON from stdout", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(null, '{"score":70,"why":"fit"}');
  assert.deepEqual(await llmJSON("p", { exec }), { score: 70, why: "fit" });
});

test("llmJSON passes model and prompt to the CLI", async () => {
  let seen;
  const exec = (cmd, args, _opts, cb) => { seen = { cmd, args }; cb(null, "{}"); };
  await llmJSON("my prompt", { model: "haiku", exec });
  assert.equal(seen.cmd, "claude");
  assert.deepEqual(seen.args, [
    "-p", "my prompt", "--model", "haiku",
    "--disallowedTools", "Read,Glob,Grep,Bash,WebFetch,WebSearch,Write,Edit,MultiEdit,NotebookEdit,Task,Agent",
  ]);
});

test("llmJSON resolves null when the CLI errors (missing binary, timeout)", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(new Error("ENOENT"));
  assert.equal(await llmJSON("p", { exec }), null);
});

test("llmJSON resolves null when exec itself throws synchronously", async () => {
  const exec = () => { throw new Error("boom"); };
  assert.equal(await llmJSON("p", { exec }), null);
});

test("llmJSON resolves null on unparseable output", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(null, "I refuse to answer in JSON");
  assert.equal(await llmJSON("p", { exec }), null);
});

test("buildJobPrompt embeds resume, vacancy and language, truncates long text", () => {
  const job = { title: "SDET", company: "Acme", location: "Remote", text: "x".repeat(10_000) };
  const p = buildJobPrompt("MY RESUME BODY", job, "uk");
  assert.match(p, /MY RESUME BODY/);
  assert.match(p, /Title: SDET/);
  assert.match(p, /Company: Acme/);
  assert.match(p, /in Ukrainian/);
  assert.match(p, /JSON only/);
  assert.ok(p.length < 8_000); // 10k description was truncated to 6k
});
