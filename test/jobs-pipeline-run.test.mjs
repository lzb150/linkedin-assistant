// End-to-end runs of jobs.mjs — the run itself: config and skills files,
// source health, exit codes, output dirs, the dashboard refresh. Helpers in
// test/helpers/jobs-pipeline.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { makeProject, runScript, waitFor, SKILLS_FIXTURE } from "./helpers/e2e.mjs";
import { rss, FEED, serveFeed, setupProject, runJobs } from "./helpers/jobs-pipeline.mjs";

test("jobs.mjs: an unreadable source-health.json is reported and left untouched, not silently reset", async (t) => {
  // Reading it as {} and writing this run's counts back destroyed the 10-run
  // baseline, and since the median rule needs 5 runs the degradation alerting
  // stayed silently off for the next five — the window in which a broken
  // scraper produces no jobs and no warning.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  const corrupt = '{"dou": [12, 14, 13],';                 // truncated mid-write
  writeFileSync(p.path("source-health.json"), corrupt);
  const out = await runScript(p, "jobs.mjs");
  assert.match(out, /source-health\.json unreadable/, "the run says why alerting is off");
  assert.equal(p.read("source-health.json"), corrupt, "the baseline file is left byte-identical");
});

test("jobs.mjs: a misspelt config key is reported, and a disabled source is named in the log", async (t) => {
  // A typo'd `llm` turns the whole gate off and a typo'd source name drops that
  // source — both used to look exactly like an ordinary run.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  const cfg = JSON.parse(readFileSync(p.path("jobs.config.json"), "utf8"));
  cfg.llmm = cfg.llm;            // the whole block, misspelt
  cfg.llm.enabledd = true;       // a misspelt key inside it
  writeFileSync(p.path("jobs.config.json"), JSON.stringify(cfg));
  const out = await runScript(p, "jobs.mjs");
  assert.match(out, /unknown top-level key "llmm"/);
  assert.match(out, /unknown llm\.enabledd/);
  assert.match(out, /djinni: disabled in config — skipped/, "a source that is off says so");
  assert.match(out, /linkedin: disabled in config — skipped/);
});

test("jobs.mjs: a corrupt skills.json degrades to an empty profile instead of killing the run", async (t) => {
  // skills.json is hand-edited by design ("edit freely" in the README), and the
  // parse was a top-level unguarded JSON.parse in a module every entry point
  // imports — so one stray comma raised a SyntaxError that never named the file
  // and killed the run before a single job was gathered.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  writeFileSync(p.path("skills.json"), '{"roles": ["sdet"],}');   // trailing comma
  const out = await runScript(p, "jobs.mjs");
  assert.match(out, /skills\.json unusable/, "the file is named");
  assert.match(out, /node make-skills\.mjs/, "and the fix is spelled out");
  assert.equal(readdirSync(p.path("applications")).filter((f) => f.endsWith(".md")).length, 0,
    "an empty profile matches nothing — visibly quiet, not silently wrong");
});

test("jobs.mjs: a corrupt jobs.config.json stops the run with the file named, not a raw SyntaxError", async (t) => {
  // Same hand-edited trailing comma as skills.json above, but nothing can run
  // without the config: both launchd agents died at import, the error naming
  // no file and no banner posted.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  writeFileSync(p.path("jobs.config.json"), '{"minScore": 25,}');
  const err = await runScript(p, "jobs.mjs").then(() => null, (e) => e);
  assert.ok(err, "the run fails");
  assert.match(err.message, /jobs\.mjs exit 1/);
  assert.match(err.message, /jobs\.config\.json unusable \(.+\) — fix the JSON/, "the file and the fix are named");
});

test("jobs.mjs: exits 1 only when every source it tried failed — a quiet run stays 0", async (t) => {
  // launchd must see a failed run as failed (the convention djinni-check.mjs
  // already follows), but the definition has to be narrow: the common case at
  // night is a perfectly healthy run that simply finds nothing new, and marking
  // that red would train the owner to ignore the signal.

  // 1) Sources fine, nothing new to write → healthy, exit 0.
  const quiet = setupProject(t, await serveFeed(t, () => rss([])));
  const out = await runScript(quiet, "jobs.mjs");          // resolves ⇒ exit 0
  assert.match(out, /Total jobs gathered: 0/);
  assert.doesNotMatch(out, /All \d+ source\(s\) failed/);

  // 2) A source that really throws (browser launch) and is the only one enabled
  //    → the run accomplished nothing, exit 1.
  const broken = makeProject(t, {
    scripts: ["jobs.mjs", "dashboard.mjs"],
    files: {
      "skills.json": SKILLS_FIXTURE,
      "resume.txt": "Eugene, Senior SDET. Playwright, TypeScript.",
      "jobs.config.json": JSON.stringify({
        minScore: 25, requireRole: true, excludeTitle: [], excludeLocation: [],
        llm: { enabled: false },
        dou: { enabled: false }, djinni: { enabled: false }, linkedin: { enabled: true, searches: [] },
      }),
    },
    playwright: 'export const chromium = { launchPersistentContext: async () => { throw new Error("Executable doesn\'t exist at /x/chromium"); } };',
  });
  const err = await runScript(broken, "jobs.mjs").then(() => null, (e) => e);
  assert.ok(err, "a run whose every source failed must exit non-zero");
  assert.match(err.message, /jobs\.mjs exit 1/);
  assert.match(err.message, /All 1 source\(s\) failed/);
});

test("jobs.mjs: a total DOU outage fails the run (exit 1); one dead feed of two does not", async (t) => {
  // fetchDou catches each feed's error so one dead feed cannot lose the others,
  // but when EVERY feed failed it throws: a network outage is a failed run the
  // scheduler must see, not a quiet "found 0".
  const p = setupProject(t, "http://127.0.0.1:1/rss");     // nothing listening
  await assert.rejects(runScript(p, "jobs.mjs"), (e) => /exit 1/.test(e.message) && /All 1 source\(s\) failed/.test(e.message));

  const q = setupProject(t, await serveFeed(t, () => FEED));
  const cfg = q.json("jobs.config.json");
  cfg.dou.feeds.push("http://127.0.0.1:1/rss");
  writeFileSync(q.path("jobs.config.json"), JSON.stringify(cfg));
  const out = await runScript(q, "jobs.mjs");              // resolves ⇒ exit 0
  assert.match(out, /DOU feed error/);
  assert.doesNotMatch(out, /All \d+ source\(s\) failed/);
});

test("jobs.mjs and dashboard.mjs create their output dirs owner-only", async (t) => {
  // applications/ and drafts/ quote recruiter messages and job descriptions;
  // they were 0755 with 0644 files. The mode applies at CREATION only, so an
  // existing directory a user already has keeps whatever they set.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  rmSync(p.path("applications"), { recursive: true, force: true });   // let jobs.mjs create it
  await runScript(p, "jobs.mjs");
  assert.equal(statSync(p.path("applications")).mode & 0o777, 0o700, "applications/ is owner-only");
  const md = readdirSync(p.path("applications")).find((f) => f.endsWith(".md"));
  assert.ok(md, "a package was written");
  assert.equal(statSync(p.path("applications", md)).mode & 0o777, 0o600, "packages are owner-only");
  assert.equal(statSync(p.path("jobs-seen.json")).mode & 0o777, 0o600, "state written atomically is owner-only too");
});

test("the dashboard renders a whole cover letter even when the letter contains \"## Action\"", async (t) => {
  // End to end over the delimiters: buildApplication writes them, dashboard.mjs
  // prefers them. Packages written before they existed still render through the
  // heading-scan fallback.
  const p = setupProject(t, await serveFeed(t, () => FEED), {
    claude: `#!/bin/sh
cat > /dev/null
echo '{"score": 90, "why": "good", "red_flags": [], "cover": "Dear team, I am great.\\n## Action\\nSECRET-TAIL"}'`,
  });
  await runScript(p, "jobs.mjs");
  await runScript(p, "dashboard.mjs");
  const html = p.read("applications", "index.html");
  assert.match(html, /SECRET-TAIL/, "the tail after the fake heading still reaches the card");
  assert.doesNotMatch(html, /<!--cover:(start|end)-->/, "the delimiters themselves are not rendered");
});

test("jobs.mjs: a DOU_ONLY run does not report the LinkedIn it skipped as absent; a disabled LinkedIn still is", async (t) => {
  // linkedin: not run at all (recent median 26) fired on every hourly DOU-only
  // run: the absent rule could not tell a deliberate skip from a config typo.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  writeFileSync(p.path("source-health.json"), JSON.stringify({ linkedin: [26, 25, 28, 27, 26] }));
  await runJobs(p);                                          // DOU_ONLY=1, writes one package → one banner
  const banner = await waitFor(p.path("notify.log"), /1 new/);
  assert.doesNotMatch(banner, /not run at all/, "a deliberate skip is not an outage");

  // Same history, no DOU_ONLY: an explicit `enabled: false` is the owner's
  // choice, not an outage either...
  const q = setupProject(t, await serveFeed(t, () => FEED));
  writeFileSync(q.path("source-health.json"), JSON.stringify({ linkedin: [26, 25, 28, 27, 26] }));
  await runScript(q, "jobs.mjs");
  assert.doesNotMatch(await waitFor(q.path("notify.log"), /1 new/), /not run at all/, "an explicit disable is not an outage");

  // ...but a missing (misspelt) linkedin section is what the rule exists for.
  const r = setupProject(t, await serveFeed(t, () => FEED));
  writeFileSync(r.path("source-health.json"), JSON.stringify({ linkedin: [26, 25, 28, 27, 26] }));
  const cfg = r.json("jobs.config.json");
  delete cfg.linkedin;
  writeFileSync(r.path("jobs.config.json"), JSON.stringify(cfg));
  await runScript(r, "jobs.mjs");
  assert.match(await waitFor(r.path("notify.log"), /not run at all/), /linkedin: not run at all \(recent median 26\)/);
});

test("jobs.mjs: only the hourly DOU_ONLY run stamps the jobs-dou heartbeat, so the full run cannot hide a dead hourly plist", async (t) => {
  // The 3-hourly full run reads the boards too. When it stamped jobs-dou, an
  // unloaded hourly plist never reached the 12 h limit and the watchdog stayed silent.
  const p = setupProject(t, await serveFeed(t, () => FEED));
  const stamps = () => (existsSync(p.path("last-success.json")) ? Object.keys(p.json("last-success.json").jobs) : []);
  await runScript(p, "jobs.mjs");   // the full run (LinkedIn disabled in this config)
  assert.ok(!stamps().includes("jobs-dou"), "the full run does not stamp the hourly job");
  await runJobs(p);                 // DOU_ONLY=1, the hourly job itself
  assert.ok(stamps().includes("jobs-dou"), "the hourly run stamps itself");
});
