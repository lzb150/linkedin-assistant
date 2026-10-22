// End-to-end runs of jobs.mjs as a black box — sources and the keyword gate.
// A local HTTP server plays the boards, fake `claude` and `osascript` binaries
// on PATH play the LLM and the notifier (test/helpers/jobs-pipeline.mjs). The
// LLM gate's runs are in jobs-pipeline-llm.test.mjs, the run-level behaviour
// (config, health, exit codes, dirs) in jobs-pipeline-run.test.mjs.
import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { runScript, waitFor, pkg, startBotApi } from "./helpers/e2e.mjs";
import { rss, AQA, FEED, serveFeed, setupProject, runJobs, mdFiles, claudeCalls, ACME } from "./helpers/jobs-pipeline.mjs";

test("jobs.mjs end-to-end: feed → gates → package → seen → health → dashboard → notification", async (t) => {
  const p = setupProject(t, await serveFeed(t, () => FEED));

  const out = await runJobs(p);
  assert.match(out, /DOU feed ok \(4\)/, "all four feed items parsed");
  assert.match(out, /Total jobs gathered: 3/, "in-feed duplicate url collapsed");
  assert.match(out, /skip \[excluded:junior\] dou: Junior QA Automation/);
  assert.match(out, /skip \[\d+ \/ llm 20\] dou: SDET Automation Engineer @ LowFit/, "LLM gate drops a confident low fit");
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] dou: Senior SDET \(Playwright\) @ Acme/);
  const stat = JSON.parse(p.read("run-stats.jsonl").trim().split("\n").pop());
  assert.equal(stat.llmCalls, 2, "both gate-passers were judged");
  assert.ok(stat.llmMs >= 1000, `two fake calls of 0.6 s each: ${stat.llmMs} ms`);
  assert.match(out, /Considered 3 new, wrote 1 application package/);

  // The package: one file, LLM verdict + tailored letter in it.
  const apps = readdirSync(p.path("applications")).filter((f) => f.endsWith(".md"));
  assert.equal(apps.length, 1);
  const pkg = p.read("applications", apps[0]);
  assert.match(pkg, /^llm_score: 85$/m);
  assert.match(pkg, /Dear team, hire me\./);
  assert.match(pkg, /^url: https:\/\/jobs\.dou\.ua\/companies\/acme\/vacancies\/1\/$/m);

  // The LLM child is hardened and every gate-passer (2) was scored exactly once.
  const claudeLog = p.read("claude.log");
  assert.equal((claudeLog.match(/^args=/gm) || []).length, 2);
  assert.match(claudeLog, /--disallowedTools \S*Bash/);
  assert.ok(!/^args=.*Acme/m.test(claudeLog), "vacancy text is not in argv");
  assert.ok(/^prompt_bytes=[1-9]\d{2,}/m.test(claudeLog), "prompt arrived on stdin");
  assert.ok(!claudeLog.split("\n").some((l) => l.startsWith("cwd=") && l.includes(p.dir)), "claude runs with cwd off the project dir");
  const starts = [...claudeLog.matchAll(/^start=(\d+)/gm)].map((m) => +m[1]).sort((a, b) => a - b);
  const ends = [...claudeLog.matchAll(/^end=(\d+)/gm)].map((m) => +m[1]).sort((a, b) => a - b);
  assert.ok(starts[1] < ends[0], `LLM calls run concurrently (second started at +${starts[1] - starts[0]}ms, first ended at +${ends[0] - starts[0]}ms)`);

  // Side files.
  const seen = p.json("jobs-seen.json");
  assert.equal(Object.keys(seen).length, 3, "all three vacancies (written, dropped, excluded) are now seen");
  assert.deepEqual(p.json("source-health.json").dou, [3]);
  assert.ok(existsSync(p.path("applications", "index.html")), "dashboard regenerated");
  assert.match(p.read("applications", "index.html"), /Senior SDET \(Playwright\)/);
  // One banner per run (fire-and-forget osascript child).
  const notify = await waitFor(p.path("notify.log"), /1 new/);
  assert.match(notify, /Job assistant/, "banner carries the app title");
  assert.match(notify, /1 new: Senior SDET \(Playwright\) @ Acme/, "single run banner names the new package");
  assert.doesNotMatch(notify, /Strong match/, "no separate strong-match banner");

  // Second run over the same feed: everything is seen, nothing new is written or scored.
  const out2 = await runJobs(p);
  assert.match(out2, /Considered 0 new, wrote 0 application package/);
  assert.equal(readdirSync(p.path("applications")).filter((f) => f.endsWith(".md")).length, 1);
  assert.equal((p.read("claude.log").match(/^args=/gm) || []).length, 2, "no LLM calls on the second run");
});

test("jobs.mjs: with telegram.json set up, each new package reaches Telegram as its own linked message", async (t) => {
  const api = await startBotApi(t);
  const telegram = JSON.stringify({ token: "1:test", chatId: 7, apiBase: api.base });
  const p = setupProject(t, await serveFeed(t, () => FEED), { files: { "telegram.json": telegram } });
  await runJobs(p);
  // The detached sender posts after the run has exited: wait for an empty outbox.
  const queued = () => readdirSync(p.path("telegram-outbox")).filter((f) => f.endsWith(".json")).length;
  for (const t0 = Date.now(); queued() && Date.now() - t0 < 10_000;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(queued(), 0, "every queued message was sent and removed");
  const texts = api.calls.map((c) => c.body.text);
  assert.equal(texts.length, 1, `one message for the one package; the "1 new" run banner stays on the Mac (got: ${texts.join(" | ")})`);
  assert.match(texts[0], /^<a href="https:\/\/jobs\.dou\.ua\/companies\/acme\/vacancies\/1\/"><b>Senior SDET \(Playwright\)<\/b><\/a>$/m);
  assert.match(texts[0], /^⭐ 85 — great fit$/m);
  assert.equal(api.calls[0].body.chat_id, 7);
});

test("jobs.mjs: Himalayas is searched for the candidate's country and its jobs reach the same gates", async (t) => {
  const asked = [];
  const job = (title, company, countries) => ({ title, companyName: company, locationRestrictions: countries, description: `<p>${AQA}</p>`,
    guid: `https://himalayas.app/companies/${company.toLowerCase()}/jobs/${title.toLowerCase().replace(/\W+/g, "-")}` });
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    asked.push(u.searchParams);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jobs: u.searchParams.get("page") ? [] : [job("Senior SDET (Playwright)", "Acme", []), job("QA Automation Engineer", "Yankee", ["United States"])] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = setupProject(t, await serveFeed(t, () => rss([])));
  const cfg = JSON.parse(readFileSync(p.path("jobs.config.json"), "utf8"));
  cfg.himalayas = { enabled: true, searches: ["SDET"] };
  writeFileSync(p.path("jobs.config.json"), JSON.stringify(cfg));

  const out = await runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf", HIMALAYAS_API: `http://127.0.0.1:${srv.address().port}/jobs/api/search` });
  assert.match(out, /Himalayas search ok \(2 over 1 page\): SDET/);
  assert.equal(asked[0].get("country"), "Ukraine", "the first candidateCountry entry (the default here)");
  assert.equal(asked[0].get("sort"), "recent");
  assert.match(out, /· location \[Remote · United States\] himalayas: QA Automation Engineer/, "a job closed to the candidate's country is dropped");
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] himalayas: Senior SDET \(Playwright\) @ Acme/);
  const [file] = mdFiles(p);
  assert.match(p.read("applications", file), /^source: himalayas$/m);
  assert.match(p.read("applications", file), /^url: https:\/\/himalayas\.app\/companies\/acme\/jobs\/senior-sdet-playwright-$/m);
  assert.deepEqual(p.json("source-health.json").himalayas, [2]);
});

test("jobs.mjs: a Telegram channel's job posts reach the same gates; a post closed to the candidate's country is dropped", async (t) => {
  const post = (id, title, company, location) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="remote_qa_jobs/${id}">` +
    `<div class="tgme_widget_message_text js-message_text"><b>Company name</b>: ${company}<br/><b>Title</b>: ${title}<br/>` +
    `<b>Job description</b>: ${AQA}<br/><b>Location</b>: ${location}<br/><b>Anywhere</b>: No<br/><b>Remote</b>: Yes</div></div></div>`;
  const asked = [];
  const srv = createServer((req, res) => {
    asked.push(req.url);
    res.setHeader("content-type", "text/html");
    res.end(`<section class="tgme_channel_history">${post(10, "QA Automation Engineer", "Yankee", "United States")}${post(11, "Senior SDET (Playwright)", "Acme", "Ukraine, Poland")}</section>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = setupProject(t, await serveFeed(t, () => rss([])));
  const cfg = JSON.parse(readFileSync(p.path("jobs.config.json"), "utf8"));
  cfg.tgchannels = { enabled: true, channels: ["@remote_qa_jobs"] };
  writeFileSync(p.path("jobs.config.json"), JSON.stringify(cfg));

  const out = await runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf", TGCHANNELS_BASE: `http://127.0.0.1:${srv.address().port}/s/` });
  assert.deepEqual(asked, ["/s/remote_qa_jobs"]);
  assert.match(out, /Telegram channel ok \(2 jobs over 1 page\): @remote_qa_jobs/);
  assert.match(out, /· location \[Remote · United States\] tgchannels: QA Automation Engineer/, "a job closed to the candidate's country is dropped");
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] tgchannels: Senior SDET \(Playwright\) @ Acme/);
  const [file] = mdFiles(p);
  assert.match(p.read("applications", file), /^source: tgchannels$/m);
  assert.match(p.read("applications", file), /^url: https:\/\/t\.me\/remote_qa_jobs\/11$/m, "no apply link: the post itself");
  assert.deepEqual(p.json("source-health.json").tgchannels, [2]);
});

test("jobs.mjs: a channel's repost of a packaged Djinni job, under another title, is that package — no LLM call", async (t) => {
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<section class="tgme_channel_history"><div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="remote_qa_jobs/384">` +
      `<div class="tgme_widget_message_text js-message_text"><b>Company name</b>: Acme<br/><b>Title</b>: QA Automation Engineer (FinTech)<br/>` +
      `<b>Job description</b>: ${AQA}<br/><b>Location</b>: Ukraine<br/><b>Anywhere</b>: No<br/><b>Remote</b>: Yes<br/><br/>` +
      `<a href="https://djinni.co/jobs/830692-qa-automation-engineer-fintech">( Job Description &amp; Apply )</a></div></div></div></section>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const existing = pkg({ source: "djinni", title: "Strong Middle SDET (Playwright)", company: "Acme", url: "https://djinni.co/jobs/830692-strong-middle-sdet-playwright/" });
  const p = setupProject(t, await serveFeed(t, () => rss([])), { packages: { "old.md": existing } });
  const cfg = JSON.parse(readFileSync(p.path("jobs.config.json"), "utf8"));
  cfg.tgchannels = { enabled: true, channels: ["@remote_qa_jobs"], fullDescription: false };
  writeFileSync(p.path("jobs.config.json"), JSON.stringify(cfg));

  const out = await runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf", TGCHANNELS_BASE: `http://127.0.0.1:${srv.address().port}/s/` });
  assert.match(out, /· already packaged \(old\.md\) tgchannels: QA Automation Engineer \(FinTech\)/);
  assert.equal(claudeCalls(p), 0, "no LLM call for a known vacancy");
  assert.deepEqual(mdFiles(p), ["old.md"], "no second package");
});

test("jobs.mjs: himalayas.worldwide false keeps only jobs that name the candidate's country", async (t) => {
  const job = (title, company, countries) => ({ title, companyName: company, locationRestrictions: countries, description: `<p>${AQA}</p>`,
    guid: `https://himalayas.app/companies/${company.toLowerCase()}/jobs/${title.toLowerCase().replace(/\W+/g, "-")}` });
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jobs: new URL(req.url, "http://x").searchParams.get("page") ? [] : [job("Senior SDET (Playwright)", "Acme", ["Poland", "Ukraine"]), job("QA Automation Engineer", "Globex", [])] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = setupProject(t, await serveFeed(t, () => rss([])));
  const cfg = JSON.parse(readFileSync(p.path("jobs.config.json"), "utf8"));
  cfg.himalayas = { enabled: true, worldwide: false, searches: ["SDET"] };
  writeFileSync(p.path("jobs.config.json"), JSON.stringify(cfg));

  const out = await runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf", HIMALAYAS_API: `http://127.0.0.1:${srv.address().port}/jobs/api/search` });
  assert.doesNotMatch(out, /unknown himalayas\.worldwide/, "worldwide is a known himalayas key");
  assert.match(out, /· location \[Remote · Worldwide\] himalayas: QA Automation Engineer/, "open to the whole world: dropped");
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] himalayas: Senior SDET \(Playwright\) @ Acme/);
  assert.equal(mdFiles(p).length, 1);
});

test("jobs.mjs: the same vacancy from another board joins the existing package as an alt link", async (t) => {
  const existing = pkg({ source: "djinni", title: "Senior SDET (Playwright)", company: "Acme", url: "https://djinni.co/jobs/1" });
  const p = setupProject(t, await serveFeed(t, () => rss([ACME])), { packages: { "old.md": existing } });
  const out = await runJobs(p);
  assert.match(out, /· dup-of-existing \(old\.md\) dou: Senior SDET \(Playwright\)/);
  assert.match(out, /Considered 0 new, wrote 0 application package/);
  assert.equal(claudeCalls(p), 0, "no LLM call for a known vacancy");
  assert.deepEqual(mdFiles(p), ["old.md"], "no second package");
  const md = p.read("applications", "old.md");
  assert.match(md, /^alt_links: dou\|https:\/\/jobs\.dou\.ua\/companies\/acme\/vacancies\/1\/$/m);
  assert.ok(md.endsWith("# Senior SDET (Playwright)\n"), "body untouched");
  assert.equal(Object.keys(p.json("jobs-seen.json")).length, 1, "marked seen so it is not re-appended");
});

test("jobs.mjs: a package already written from the SAME source and url is not written a second time", async (t) => {
  // After a seen-store quarantine every live vacancy looks new again. The
  // cross-run guard only caught a DIFFERENT source, so the same vacancy from
  // the same board was re-scored and written again — the filename embeds a
  // fresh minute stamp, so it could never collide and the duplicate was
  // invisible. "Same source, different url" is still a distinct req.
  const url = "https://jobs.dou.ua/companies/acme/vacancies/1/";
  const p = setupProject(t, await serveFeed(t, () => rss([
    { title: "Senior SDET (Playwright) в Acme, Київ", link: url, desc: AQA },
  ])), { packages: { "existing.md": pkg({ source: "dou", title: "Senior SDET (Playwright)", company: "Acme", url }) } });
  const out = await runScript(p, "jobs.mjs");
  assert.match(out, /already packaged/, "recognised as the package we already have");
  const files = readdirSync(p.path("applications")).filter((f) => f.endsWith(".md"));
  assert.deepEqual(files, ["existing.md"], "no second package for the same source+url");
  assert.equal(Object.keys(p.json("jobs-seen.json")).length, 1, "re-stamped as seen so it settles next run");
});

test("jobs.mjs: two same-source packages sharing a key both guard against a rewrite", async (t) => {
  // The index kept one package per key, so whichever was read last hid the
  // other's url: that vacancy was re-scored and written a second time.
  const url = "https://jobs.dou.ua/companies/acme/vacancies/1/";
  const other = "https://jobs.dou.ua/companies/acme/vacancies/2/";
  const p = setupProject(t, await serveFeed(t, () => rss([
    { title: "Senior SDET (Playwright) в Acme, Київ", link: url, desc: AQA },
  ])), { packages: {
    "a.md": pkg({ source: "dou", title: "Senior SDET (Playwright)", company: "Acme", url }),
    "b.md": pkg({ source: "dou", title: "Senior SDET (Playwright)", company: "Acme", url: other }),
  } });
  const out = await runScript(p, "jobs.mjs");
  assert.match(out, /already packaged \(a\.md\)/);
  const files = readdirSync(p.path("applications")).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["a.md", "b.md"], "no third package");
});
