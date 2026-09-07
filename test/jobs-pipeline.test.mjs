// End-to-end run of jobs.mjs as a black box in a throwaway project dir:
// a local HTTP server plays the DOU RSS feed, fake `claude` and `osascript`
// binaries on PATH play the LLM and the notifier. Covers the whole pipeline
// (fetch → filters → dedup → keyword gate → LLM gate → package → seen →
// health → dashboard → notification) that no unit test exercises — the
// "LLM silently off" and "LLM timeout" regressions both lived here for weeks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, symlinkSync, mkdirSync, readdirSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
  const dir = mkdtempSync(join(tmpdir(), "jobs-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ["jobs.mjs", "dashboard.mjs", "skills.json"]) copyFileSync(join(ROOT, f), join(dir, f));
  // lib/ is COPIED, not symlinked: Node resolves ESM imports through realpath,
  // so a symlinked lib/notify.mjs would compute ROOT as the real repo and queue
  // banners into the user's Jobs.app. node_modules can stay a symlink.
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "resume.txt"), "Eugene, Senior SDET. Playwright, TypeScript, API testing.");
  writeFileSync(join(dir, "jobs.config.json"), JSON.stringify({
    minScore: 25, requireRole: true, excludeTitle: ["junior"], excludeLocation: [],
    llm: { enabled: true, model: "haiku", maxPerRun: 15, minScore: 50 },
    dou: { enabled: true, feeds: [feedUrl] },
    djinni: { enabled: false }, jooble: { enabled: false }, linkedin: { enabled: false },
    workua: { enabled: false }, robota: { enabled: false }, glassdoor: { enabled: false },
  }));
  // Fake binaries. `claude` scores by company name and records how it was
  // called (cwd must be off the project — it sees untrusted board text).
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh
echo "cwd=$(pwd)" >> "${dir}/claude.log"; echo "args=$*" >> "${dir}/claude.log"
case "$*" in *LowFit*) echo '{"score": 20, "why": "no", "red_flags": [], "cover": "x"}' ;;
  *) echo 'Sure! {"score": 85, "why": "great fit", "red_flags": [], "cover": "Dear team, hire me."}' ;; esac`);
  // notify.mjs falls back to osascript on macOS and notify-send on Linux (CI runs both).
  for (const n of ["osascript", "notify-send"]) writeFileSync(join(bin, n), `#!/bin/sh\necho "$*" >> "${dir}/notify.log"`);
  for (const b of ["claude", "osascript", "notify-send"]) chmodSync(join(bin, b), 0o755);
  return { dir, bin };
}

// The notifier is fire-and-forget (two osascript children spawned right before
// process.exit), so the log fills a few ms after jobs.mjs has exited — and in
// two writes. Wait for the CONTENT we need, not for the file to exist (the
// existence check raced the second write on the macOS runner: 3 red mains).
async function waitFor(path, re, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    try { const s = readFileSync(path, "utf8"); if (re.test(s)) return s; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

// Async on purpose: a sync spawn would block this process's event loop, and the
// fake feed server lives in it.
async function runJobs({ dir, bin }) {
  const { stdout } = await promisify(execFile)(process.execPath, [join(dir, "jobs.mjs")], {
    cwd: dir, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, DOU_ONLY: "1", PATH: `${bin}${delimiter}${process.env.PATH}`, CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf" },
  });
  return stdout;
}

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
  const apps = readdirSync(join(p.dir, "applications")).filter((f) => f.endsWith(".md"));
  assert.equal(apps.length, 1);
  const pkg = readFileSync(join(p.dir, "applications", apps[0]), "utf8");
  assert.match(pkg, /^llm_score: 85$/m);
  assert.match(pkg, /Dear team, hire me\./);
  assert.match(pkg, /^url: https:\/\/jobs\.dou\.ua\/companies\/acme\/vacancies\/1\/$/m);

  // The LLM child is hardened and every gate-passer (2) was scored exactly once.
  const claudeLog = readFileSync(join(p.dir, "claude.log"), "utf8");
  assert.equal((claudeLog.match(/^args=/gm) || []).length, 2);
  assert.match(claudeLog, /--disallowedTools \S*Bash/);
  assert.ok(!claudeLog.split("\n").some((l) => l.startsWith("cwd=") && l.includes(p.dir)), "claude runs with cwd off the project dir");

  // Side files.
  const seen = JSON.parse(readFileSync(join(p.dir, "jobs-seen.json"), "utf8"));
  assert.equal(Object.keys(seen).length, 3, "all three vacancies (written, dropped, excluded) are now seen");
  assert.deepEqual(JSON.parse(readFileSync(join(p.dir, "source-health.json"), "utf8")).dou, [3]);
  assert.ok(existsSync(join(p.dir, "applications", "index.html")), "dashboard regenerated");
  assert.match(readFileSync(join(p.dir, "applications", "index.html"), "utf8"), /Senior SDET \(Playwright\)/);
  const notify = await waitFor(join(p.dir, "notify.log"), /dou 1 new/);
  assert.match(notify, /Job assistant/, "banners carry the app title");
  assert.match(notify, /Strong match: Senior SDET \(Playwright\) @ Acme/, "separate strong-match banner");
  assert.match(notify, /dou 1 new/, "run digest banner");

  // Second run over the same feed: everything is seen, nothing new is written or scored.
  const out2 = await runJobs(p);
  assert.match(out2, /Considered 0 new, wrote 0 application package/);
  assert.equal(readdirSync(join(p.dir, "applications")).filter((f) => f.endsWith(".md")).length, 1);
  assert.equal((readFileSync(join(p.dir, "claude.log"), "utf8").match(/^args=/gm) || []).length, 2, "no LLM calls on the second run");
});
