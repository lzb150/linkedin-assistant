// End-to-end run of jobs.mjs as a black box in a throwaway project dir:
// a local HTTP server plays the DOU RSS feed, fake `claude` and `osascript`
// binaries on PATH play the LLM and the notifier. Covers the whole pipeline
// (fetch → filters → dedup → keyword gate → LLM gate → package → seen →
// health → dashboard → notification) that no unit test exercises — the
// "LLM silently off" and "LLM timeout" regressions both lived here for weeks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { makeProject, runScript, waitFor, SKILLS_FIXTURE } from "./helpers/e2e.mjs";

const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
  `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><description><![CDATA[${i.desc}]]></description></item>`).join("")}</channel></rss>`;

const AQA = "We need a test automation engineer: Playwright, TypeScript, API testing, REST, CI/CD, Jenkins, e2e regression.";
const FEED = rss([
  { title: "Senior SDET (Playwright) в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/1/", desc: AQA },
  { title: "SDET Automation Engineer в LowFit, Львів", link: "https://jobs.dou.ua/companies/lowfit/vacancies/2/", desc: AQA },
  { title: "Junior QA Automation в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/3/", desc: AQA },
  { title: "Senior SDET (Playwright) в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/1/", desc: AQA }, // same url twice in the feed
]);

function setupProject(t, feedUrl) {
  return makeProject(t, {
    scripts: ["jobs.mjs", "dashboard.mjs"],
    files: {
      "skills.json": SKILLS_FIXTURE,
      "resume.txt": "Eugene, Senior SDET. Playwright, TypeScript, API testing.",
      "jobs.config.json": JSON.stringify({
        minScore: 25, requireRole: true, excludeTitle: ["junior"], excludeLocation: [],
        llm: { enabled: true, model: "haiku", maxPerRun: 15, minScore: 50 },
        dou: { enabled: true, feeds: [feedUrl] },
        djinni: { enabled: false }, linkedin: { enabled: false },
      }),
    },
    // Fake `claude` scores by company name and logs how it was called into the
    // project dir (the parent of bin/) — cwd must be OFF the project, it sees
    // untrusted board text.
    // Each call sleeps 0.6 s and logs start/end (ms) so the test can prove the
    // two gate-passers were scored concurrently, not one after the other.
    bins: { claude: `#!/bin/sh
LOG="$(dirname "$0")/../claude.log"; now() { node -e 'process.stdout.write(String(Date.now()))'; }
echo "start=$(now)" >> "$LOG"; sleep 0.6
echo "cwd=$(pwd)" >> "$LOG"; echo "args=$*" >> "$LOG"; echo "end=$(now)" >> "$LOG"
case "$*" in *LowFit*) echo '{"score": 20, "why": "no", "red_flags": [], "cover": "x"}' ;;
  *) echo 'Sure! {"score": 85, "why": "great fit", "red_flags": [], "cover": "Dear team, hire me."}' ;; esac
` },
  });
}

const runJobs = (p) => runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf" });

test("jobs.mjs end-to-end: feed → gates → package → seen → health → dashboard → notification", async (t) => {
  const srv = createServer((_req, res) => { res.setHeader("content-type", "application/rss+xml"); res.end(FEED); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = setupProject(t, `http://127.0.0.1:${srv.address().port}/rss`);

  const out = await runJobs(p);
  assert.match(out, /DOU feed ok \(4\)/, "all four feed items parsed");
  assert.match(out, /Total jobs gathered: 3/, "in-feed duplicate url collapsed");
  assert.match(out, /skip \[excluded:junior\] dou: Junior QA Automation/);
  assert.match(out, /skip \[\d+ \/ llm 20\] dou: SDET Automation Engineer @ LowFit/, "LLM gate drops a confident low fit");
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] dou: Senior SDET \(Playwright\) @ Acme/);
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
