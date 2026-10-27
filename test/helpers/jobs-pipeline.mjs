// End-to-end run of jobs.mjs as a black box in a throwaway project dir:
// a local HTTP server plays the DOU RSS feed, fake `claude` and `osascript`
// binaries on PATH play the LLM and the notifier. Covers the whole pipeline
// (fetch → filters → dedup → keyword gate → LLM gate → package → seen →
// health → dashboard → notification) that no unit test exercises — the
// "LLM silently off" and "LLM timeout" regressions both lived here for weeks.
// Shared by the three jobs-pipeline test files (split so node --test runs them
// in parallel: 27 runs of 3–4 s each used to go one after another in one file).
import { readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { makeProject, runScript, SKILLS_FIXTURE } from "./e2e.mjs";

export const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
  `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}<description><![CDATA[${i.desc}]]></description></item>`).join("")}</channel></rss>`;

// Over 300 characters, like a real posting: a shorter text is "no description
// yet" to the keyword gate and stays unseen when the LLM turns it down.
export const AQA = "We need a test automation engineer: Playwright, TypeScript, API testing, REST, CI/CD, Jenkins, e2e regression." +
  " The team ships a web platform used by thousands of customers every day, and values careful engineering and steady delivery." +
  " You will own the regression suite and work closely with developers and product owners.";
export const FEED = rss([
  { title: "Senior SDET (Playwright) в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/1/", desc: AQA },
  { title: "SDET Automation Engineer в LowFit, Львів", link: "https://jobs.dou.ua/companies/lowfit/vacancies/2/", desc: AQA },
  { title: "Junior QA Automation в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/3/", desc: AQA },
  { title: "Senior SDET (Playwright) в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/1/", desc: AQA }, // same url twice in the feed
]);

// Local HTTP server playing the DOU feed; `body()` is read per request so a
// test can change the feed between runs.
export async function serveFeed(t, body) {
  const srv = createServer((_req, res) => { res.setHeader("content-type", "application/rss+xml"); res.end(body()); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/rss`;
}

// `llm` overrides the llm config block, `packages` pre-existing applications/*.md,
// `claude` replaces the fake CLI below.
export function setupProject(t, feedUrl, { llm = {}, packages, claude, files = {} } = {}) {
  return makeProject(t, {
    scripts: ["jobs.mjs", "dashboard.mjs"],
    packages,
    files: {
      "skills.json": SKILLS_FIXTURE,
      "resume.txt": "Eugene, Senior SDET. Playwright, TypeScript, API testing.",
      "jobs.config.json": JSON.stringify({
        minScore: 25, requireRole: true, excludeTitle: ["junior"], excludeLocation: [],
        llm: { enabled: true, model: "haiku", maxPerRun: 15, minScore: 50, ...llm },
        dou: { enabled: true, feeds: [feedUrl] },
        djinni: { enabled: false }, linkedin: { enabled: false },
      }),
      ...files,
    },
    // Fake `claude` scores by company name and logs how it was called into the
    // project dir (the parent of bin/) — cwd must be OFF the project, it sees
    // untrusted board text.
    // Each call sleeps 0.6 s and logs start/end (ms) so the test can prove the
    // two gate-passers were scored concurrently, not one after the other.
    bins: { claude: claude || `#!/bin/sh
LOG="$(dirname "$0")/../claude.log"; now() { node -e 'process.stdout.write(String(Date.now()))'; }
echo "start=$(now)" >> "$LOG"; sleep 0.6
PROMPT="$(cat)"   # the prompt arrives on stdin, never in argv (ps-visible; 128 KB argv cap on Linux)
echo "cwd=$(pwd)" >> "$LOG"; echo "args=$*" >> "$LOG"; echo "prompt_bytes=$(printf %s "$PROMPT" | wc -c | tr -d " ")" >> "$LOG"; echo "end=$(now)" >> "$LOG"
case "$PROMPT" in *LowFit*) echo '{"score": 20, "why": "no", "red_flags": [], "cover": "x"}' ;;
  *) echo 'Sure! {"score": 85, "why": "great fit", "red_flags": [], "cover": "Dear team, hire me."}' ;; esac
` },
  });
}

export const runJobs = (p) => runScript(p, "jobs.mjs", { DOU_ONLY: "1", CANDIDATE_NAME: "Eugene", RESUME_PATH: "/x/resume.pdf" });
export const mdFiles = (p) => readdirSync(p.path("applications")).filter((f) => f.endsWith(".md"));
export const claudeCalls = (p) => (existsSync(p.path("claude.log")) ? p.read("claude.log").match(/^args=/gm) || [] : []).length;
export const ACME = { title: "Senior SDET (Playwright) в Acme, Київ", link: "https://jobs.dou.ua/companies/acme/vacancies/1/", desc: AQA };
export const BETA = { title: "SDET Automation Engineer в Beta, Львів", link: "https://jobs.dou.ua/companies/beta/vacancies/2/", desc: AQA };
export const GAMMA = { title: "Test Automation Engineer в Gamma, Одеса", link: "https://jobs.dou.ua/companies/gamma/vacancies/3/", desc: AQA };
