import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, fetchLinkedInJobs } from "../../lib/sources/linkedin-jobs.mjs";

test("buildUrl includes keywords and location and always sorts by date", () => {
  const url = buildUrl({ keywords: "QA Automation", location: "Ukraine" });
  assert.match(url, /^https:\/\/www\.linkedin\.com\/jobs\/search\/\?/);
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("keywords"), "QA Automation");
  assert.equal(qs.get("location"), "Ukraine");
  assert.equal(qs.get("sortBy"), "DD");
  assert.equal(qs.get("f_WT"), null, "no remote filter unless requested");
});

test("buildUrl adds the remote filter f_WT=2 when remote is set", () => {
  const qs = new URL(buildUrl({ keywords: "SDET", remote: true })).searchParams;
  assert.equal(qs.get("f_WT"), "2");
});

test("buildUrl omits empty keywords and location but still sorts by date", () => {
  const qs = new URL(buildUrl({})).searchParams;
  assert.equal(qs.get("keywords"), null);
  assert.equal(qs.get("location"), null);
  assert.equal(qs.get("sortBy"), "DD");
});

// fetchLinkedInJobs reads each card in ONE evaluate() before clicking (a clicked
// list re-renders and detaches the other handles; per-action calls on detached
// handles each burned the full 30s default timeout — 15 cards ≈ 35 min).
// `rounds` = what page.$$ returns on each call (the last round repeats), so a
// test can simulate LinkedIn rendering more cards after a scroll.
function fakePage(...rounds) {
  const calls = [];
  let round = 0;
  const page = {
    calls,
    goto: async () => { calls.push("goto"); },
    mouse: { wheel: async () => {} },
    $$: async () => (rounds[Math.min(round++, rounds.length - 1)]).map((c, i, all) => ({
      // readCard runs in-page via evaluate; the scroll helper is also an evaluate
      evaluate: async (fn) => (fn.name === "readCard" ? c : calls.push(`scroll:${i === all.length - 1 ? "last" : i}`)),
      click: async (opts) => { calls.push(`click:${opts?.timeout}`); },
    })),
    locator: () => ({ first: () => ({ innerText: async (opts) => { calls.push(`desc:${opts?.timeout}`); return "  Job description  "; } }) }),
  };
  return page;
}

test("fetchLinkedInJobs extracts cards via a single evaluate, de-dups by url before the cap, skips cards without href", async () => {
  const page = fakePage([
    { title: "SDET", href: "/jobs/view/123/?refId=x", company: "Acme", location: "Kyiv" },
    { title: "No link", href: "", company: "Ghost", location: "" },
    { title: "Abs", href: "https://www.linkedin.com/jobs/view/456/?a=1", company: "Beta", location: "" },
    // SEL.card matches the <li> AND its inner div → the same job appears twice
    { title: "SDET", href: "/jobs/view/123/?refId=y", company: "Acme", location: "Kyiv" },
    { title: "Over cap", href: "/jobs/view/789/", company: "Gamma", location: "" },
  ]);
  const jobs = await fetchLinkedInJobs(page, { maxResults: 2, searches: [{ keywords: "SDET", location: "Ukraine" }] }, () => {}, { sleep: async () => {} });
  assert.deepEqual(jobs.map((j) => j.url), ["https://www.linkedin.com/jobs/view/123/", "https://www.linkedin.com/jobs/view/456/"], "de-dup before the cap: 2 unique jobs, not 1");
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, 2, "duplicates and over-cap cards are never clicked");
  assert.equal(jobs[0].company, "Acme");
  assert.equal(jobs[0].location, "Kyiv");
  assert.equal(jobs[1].location, "Ukraine", "search location is the fallback");
  assert.match(jobs[0].text, /^SDET at Acme\. Kyiv\. Job description$/);
  assert.ok(page.calls.every((c) => !c.endsWith(":undefined")), "every click/desc wait carries an explicit short timeout");
});

test("fetchLinkedInJobs scrolls the list until maxResults unique cards are rendered, stops when nothing new appears", async () => {
  const a = { title: "A", href: "/jobs/view/1/", company: "X", location: "" };
  const b = { title: "B", href: "/jobs/view/2/", company: "X", location: "" };
  const ghost = { title: "", href: "", company: "", location: "" }; // virtualised, not rendered yet
  // round 1: A + two ghosts; round 2 (after scroll): A, B rendered; round 3+: no change
  const page = fakePage([a, ghost, ghost], [a, b, ghost], [a, b, ghost]);
  const jobs = await fetchLinkedInJobs(page, { maxResults: 5, searches: [{ keywords: "x" }] }, () => {}, { sleep: async () => {} });
  assert.deepEqual(jobs.map((j) => j.title), ["A", "B"]);
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, 2, "each job is clicked exactly once across rounds");
  assert.ok(page.calls.filter((c) => c.startsWith("scroll")).length >= 1, "scrolled the last card into view to render more");
  assert.ok(page.calls.filter((c) => c.startsWith("scroll")).length <= 3, "gives up after the list stops growing");
});

test("fetchLinkedInJobs does not scroll once maxResults is reached", async () => {
  const a = { title: "A", href: "/jobs/view/1/", company: "X", location: "" };
  const b = { title: "B", href: "/jobs/view/2/", company: "X", location: "" };
  const page = fakePage([a, b]);
  const jobs = await fetchLinkedInJobs(page, { maxResults: 2, searches: [{ keywords: "x" }] }, () => {}, { sleep: async () => {} });
  assert.equal(jobs.length, 2);
  assert.equal(page.calls.filter((c) => c.startsWith("scroll")).length, 0);
});

// One LinkedIn search took 1887s in production (three more took 913s, 1059s,
// 368s): some await inside the card loop hangs past every per-action timeout.
// A per-search wall-clock deadline keeps what was gathered and moves on; the
// abandoned loop must not keep clicking cards on the next search's page.
test("fetchLinkedInJobs abandons a search at the deadline, keeps the cards gathered so far, and the stalled loop clicks nothing more", async () => {
  const cards = [
    { title: "A", href: "/jobs/view/1/", company: "X", location: "Kyiv" },
    { title: "B", href: "/jobs/view/2/", company: "X", location: "Kyiv" },
    { title: "C", href: "/jobs/view/3/", company: "X", location: "Kyiv" },
  ];
  let release;
  let hangOnce = true;
  const page = fakePage(cards);
  const $$ = page.$$;
  page.$$ = async () => (await $$()).map((c, i) => (i === 1 ? {
    ...c,
    click: async (opts) => {
      page.calls.push(`click:${opts?.timeout}`);
      if (hangOnce) { hangOnce = false; await new Promise((r) => { release = r; }); }
    },
  } : c));
  const logs = [];
  const t0 = Date.now();
  const cfg = { maxResults: 5, searches: [{ keywords: "qa" }, { keywords: "sdet" }] };
  const out = await fetchLinkedInJobs(page, cfg, (l) => logs.push(l), { sleep: async () => {}, searchTimeoutMs: 100 });
  assert.ok(Date.now() - t0 < 2000, "returned without waiting for the hung click");
  // Where exactly the 100 ms timer lands relative to the fake awaits depends on
  // the machine (CI once saw it before B's click, moving the hang to the second
  // search), so assert what holds for every ordering: no duplicates, A (read
  // before any hang) survives, the deadline was logged.
  const titles = out.map((j) => j.title);
  assert.equal(new Set(titles).size, titles.length, "no duplicate urls");
  assert.ok(titles.includes("A"), `A gathered before the hang survives: ${titles}`);
  assert.ok(logs.some((l) => /search deadline .*exceeded/.test(l)), logs.join("\n"));
  const clicksBefore = page.calls.filter((c) => c.startsWith("click")).length;
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, clicksBefore, "the released loop stops instead of clicking the next card");
});

// Cards the caller already knows (seen store / excluded title) are returned
// from their list fields without a click or description — 17–20 of ~30 cards
// per production run, ~2.2 s each.
test("fetchLinkedInJobs skips the click for cards the skip() predicate knows, still returns them", async () => {
  const page = fakePage([
    { title: "Known SDET", href: "/jobs/view/1/", company: "Acme", location: "Kyiv" },
    { title: "New AQA", href: "/jobs/view/2/", company: "Beta", location: "" },
  ]);
  const seen = [];
  const jobs = await fetchLinkedInJobs(page, { maxResults: 5, searches: [{ keywords: "SDET", location: "Ukraine" }] }, () => {},
    { sleep: async () => {}, skip: (j) => { seen.push(j); return j.title === "Known SDET"; } });
  assert.deepEqual(seen.map((j) => [j.title, j.company, j.url]), [["Known SDET", "Acme", "https://www.linkedin.com/jobs/view/1/"], ["New AQA", "Beta", "https://www.linkedin.com/jobs/view/2/"]], "predicate sees list fields + canonical url");
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, 1, "only the unknown card is opened");
  assert.equal(jobs.length, 2, "known card is still returned so the caller can re-stamp it as seen");
  assert.equal(jobs[0].text, "Known SDET at Acme. Kyiv. ", "no description for a skipped card");
  assert.match(jobs[1].text, /Job description$/);
});
