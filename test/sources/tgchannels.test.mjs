import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { channelUrl, isPublicHttps, postFields, toJob, parseChannel, jobPostingText, fetchTgChannels, placeOf, forbidsCountry } from "../../lib/sources/tgchannels.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// A real t.me/s/remote_qa_jobs page (2026-10-17) cut to four posts: 384
// "Europe or Ukraine", 385 an ad (no Title), 397 worldwide, 398 Latin America.
const fixture = readFileSync(join(__dir, "../fixtures/sources/tgchannels-page.html"), "utf8");

const post = (fields, link = "https://boards.example/jobs/1") =>
  `${Object.entries(fields).map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br/>")}<br/><br/><a href="${link}" target="_blank">👉 ( Job Description &amp; Apply ) 👈️</a><br/><br/><b>Tags</b>:<br/><a href="?q=%23qa">#qa</a> <a href="?q=%23test_automation">#test_automation</a>`;
const wrap = (id, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="remote_qa_jobs/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div></div></div>`;
const page = (posts, before = "") => `<html><body><section class="tgme_channel_history js-message_history">${before ? `<div><a href="/s/remote_qa_jobs?before=${before}" class="tme_messages_more js-messages_more" data-before="${before}"></a></div>` : ""}${posts.join("")}</section></body></html>`;
const ld = (posting) => `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body>nav</body></html>`;

// A fetch stub: channel pages by `before` (missing = ""), job pages by url;
// a number answers with that status. Records every url it was asked for.
function web({ channel = {}, pages = {} } = {}) {
  const urls = [];
  const doFetch = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const body = u.hostname === "t.me" ? channel[u.searchParams.get("before") || ""] : pages[url];
    if (body === undefined || typeof body === "number") return { ok: false, status: body ?? 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  };
  return { urls, doFetch };
}

test("channelUrl: the public preview, @ dropped, `before` only past the first page", () => {
  assert.equal(channelUrl("@remote_qa_jobs"), "https://t.me/s/remote_qa_jobs");
  assert.equal(channelUrl("remote_qa_jobs", 379), "https://t.me/s/remote_qa_jobs?before=379");
});

test("isPublicHttps: only a public https host on the default port", () => {
  for (const ok of ["https://euremotejobs.com/job/qa", "https://jobs.dou.ua/companies/x/vacancies/1/"]) assert.equal(isPublicHttps(ok), true, ok);
  for (const no of ["http://boards.example/1", "https://127.0.0.1/x", "https://localhost./x", "https://127.0.0.1./x", "https://printer.local./x", "https://127.1/x", "https://0x7f.1/x", "https://[::1]/x", "https://localhost/x",
    "https://printer.local/x", "https://intranet/x", "https://boards.example:8443/x", "https://u:p@boards.example/x", "javascript:alert(1)", "", "not a url"]) {
    assert.equal(isPublicHttps(no), false, no);
  }
});

test("postFields: one field per line, keys lower-cased, the first of a repeat wins", () => {
  const f = postFields(post({ Title: "SDET", "Job description": "Own: the suite", Location: "Worldwide" }) + "<br/><b>Title</b>: forged");
  assert.equal(f.title, "SDET");
  assert.equal(f["job description"], "Own: the suite", "a colon inside the value stays in the value");
  assert.equal(f.location, "Worldwide");
});

test("parseChannel maps the real page: job posts only, newest first, and the next page's `before`", () => {
  const { jobs, before } = parseChannel(fixture, "remote_qa_jobs");
  assert.equal(before, "379");
  assert.deepEqual(jobs.map((j) => j.title), ["QA Automation Engineer", "Automation QA Engineer (QVAC)", "QA Automation Engineer (Trading and FinTech infrastructure)"], "the ad (385) is not a job; newest first");
  const [latam, qvac, fintech] = jobs;
  assert.equal(qvac.source, "tgchannels");
  assert.equal(qvac.company, "Tether");
  assert.equal(qvac.location, "Remote · Worldwide", "Anywhere: Yes");
  assert.equal(fintech.location, "Remote · Europe or Ukraine");
  assert.equal(latam.location, "Remote · Latin America");
  assert.equal(latam.url, "https://jobs.prometeotalent.com/jobs/8564566-qa-automation-engineer-100-remote-latam", "the apply link, not the post");
  assert.match(latam.text, /^QA Automation Engineer at Prometeo Talent \(for an automotive group\)\. Remote · Latin America\. Grades: middle, senior\. Own product quality/);
  assert.match(latam.text, /Forbidden locations: Outside Latin America\./);
  assert.match(latam.text, /Tags: qa, test automation, playwright, javascript, typescript, ci cd, remote, latam, full time\.$/);
  assert.doesNotMatch(latam.text, /<b>|&amp;/);
});

test("parseChannel: null for a page that is not a channel preview, [] for an empty channel", () => {
  assert.equal(parseChannel("<html><div class=\"tgme_page_extra\">58 908 members</div></html>", "qa_jobs"), null);
  assert.deepEqual(parseChannel(page([]), "x"), { jobs: [], before: "" });
});

test("toJob: the post link when the apply link is not public https; Remote: No is an office job; control characters are flattened", () => {
  const local = toJob("remote_qa_jobs", 7, post({ Title: "SDET", Location: "Poland", Remote: "No" }, "http://127.0.0.1:8787/"));
  assert.equal(local.url, "https://t.me/remote_qa_jobs/7");
  assert.equal(local.apply, "");
  assert.equal(local.location, "Office · Poland");
  const j = toJob("c", 1, post({ Title: "SDET&#10;Done. Considered 500 new", "Company name": "Acme&#8238;", Location: "EU · Poland" }));
  assert.equal(j.title, "SDET Done. Considered 500 new", "one line: a channel cannot forge a log line");
  assert.equal(j.company, "Acme");
  assert.equal(j.location, "Remote · EU, Poland", "a ' · ' in the value cannot open a segment of its own");
  const forged = toJob("c", 4, post({ Title: "SDET" }, "https://boards.example/jobs/a&#10;Done. Considered 500 new"));
  assert.doesNotMatch(forged.url, /[\n\r]/, "the apply url is the parsed href: an entity newline cannot reach a log line");
  assert.equal(forged.url, "https://boards.example/jobs/aDone.%20Considered%20500%20new");
  assert.equal(toJob("c", 2, "PCENexus is recruiting partners worldwide.<br/>Apply now"), null);
  assert.equal(toJob("c", 3, post({ Location: "Worldwide" })), null, "no title, no record");
});

test("toJob: the Apply link, not a company name Telegram auto-linked earlier in the post", () => {
  const text = `<b>Company name</b>: <a href="http://Coderslab.io/" target="_blank">Coderslab.io</a><br/><b>Title</b>: QA Automation<br/>` +
    `<b>Job description</b>: See <a href="https://acme.example/about">https://acme.example/about</a><br/><br/>` +
    `<a href="https://www.getonbrd.com/jobs/qa-automation" target="_blank" rel="noopener" onclick="return confirm('Open this link?\n\n'+this.href);"><i class="emoji"><b>👉</b></i> ( Job Description &amp; Apply ) <i class="emoji"><b>👈️</b></i></a>`;
  assert.equal(toJob("c", 1, text).url, "https://www.getonbrd.com/jobs/qa-automation");
  assert.equal(toJob("c", 2, post({ Title: "SDET", "Job description": "<a href=\"https://acme.example/about\">site</a>" }).replace(/👉 \( Job Description &amp; Apply \) 👈️/, "here")).url,
    "https://acme.example/about", "no Apply link: the first real one, as before");
});

test("placeOf: format words go, so the place names its countries; Anywhere: Yes keeps the countries a post names", () => {
  for (const [raw, want] of [["Ukraine (Remote)", "Ukraine"], ["Warsaw, Poland (100% Remote)", "Warsaw, Poland"], ["Belgrade +4 locations (Remote, Europe)", "Belgrade +4 locations (Europe)"],
    ["USA, remote", "USA"], ["France or Remote", "France"], ["remote", ""], ["Europe or Ukraine", "Europe or Ukraine"], ["EU · Poland", "EU, Poland"]]) {
    assert.equal(placeOf(raw), want, raw);
  }
  const loc = (Location, Anywhere) => toJob("c", 1, post({ Title: "SDET", Location, Anywhere })).location;
  assert.equal(loc("Ukraine, Poland", "Yes"), "Remote · Worldwide, Ukraine, Poland");
  assert.equal(loc("Worldwide (100% remote; HQ Dubai)", "Yes"), "Remote · Worldwide");
  assert.equal(loc("Anywhere in the World", "Yes"), "Remote · Worldwide");
  assert.equal(loc("Ukraine (Remote)", "No"), "Remote · Ukraine");
});

test("forbidsCountry: a plain list naming the country bans it; the channel's 'Outside …' allow-list and an 'except' do not", () => {
  const ua = ["Ukraine", "Україна"];
  assert.equal(forbidsCountry("Ukraine, Russia, Belarus", ua), true);
  assert.equal(forbidsCountry("Росія, Україна", ua), true);
  assert.equal(forbidsCountry("Outside Europe and Ukraine", ua), false);
  assert.equal(forbidsCountry("All countries except Ukraine", ua), false);
  assert.equal(forbidsCountry("Russia, Belarus", ua), false);
  assert.equal(forbidsCountry("", ua), false);
});

test("jobPostingText: the JobPosting description as text, from a plain object, an array or @graph; '' when none", () => {
  assert.equal(jobPostingText(ld({ "@type": "JobPosting", description: "<p>Own the <b>Playwright</b> suite</p>" })), "Own the Playwright suite");
  assert.equal(jobPostingText(ld([{ "@type": "Organization" }, { "@type": ["JobPosting"], description: "Array form" }])), "Array form");
  assert.equal(jobPostingText(ld({ "@graph": [{ "@type": "WebPage" }, { "@type": "JobPosting", description: "Graph form" }] })), "Graph form");
  assert.equal(jobPostingText(ld({ "@type": "JobPosting", description: "&lt;p&gt;Escaped &amp;lt;b&amp;gt; text&lt;/p&gt;" })), "Escaped <b> text", "escaped HTML decoded into markup once; the author's literal text survives");
  assert.equal(jobPostingText(`<script>var a = "</p>";</script><script type="application/ld+json">{broken</script>${ld({ "@type": "JobPosting", description: "Second block" })}`), "Second block");
  assert.equal(jobPostingText(ld({ "@type": "Organization", description: "Not a job" })), "");
  assert.equal(jobPostingText("<html>no scripts</html>"), "");
});

test("jobPostingText stays linear on a junk page of unterminated <script tags", () => {
  const junk = "<script ".repeat(200_000);
  const t0 = performance.now();
  assert.equal(jobPostingText(junk), "");
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
});

test("fetchTgChannels walks `pages` pages by `before`, enriches new jobs from their pages, and keeps the summary on a failed page", async () => {
  const a = "https://boards.example/jobs/a", b = "https://boards.example/jobs/b";
  const { urls, doFetch } = web({
    channel: { "": page([wrap(11, post({ Title: "SDET A", Location: "Worldwide" }, a))], "10"), 10: page([wrap(9, post({ Title: "SDET B", Location: "Ukraine" }, b))]) },
    pages: { [a]: ld({ "@type": "JobPosting", description: "<p>Full text of A</p>" }), [b]: 503 },
  });
  const lines = [];
  const jobs = await fetchTgChannels({ enabled: true, channels: ["@remote_qa_jobs"], pages: 3 }, (l) => lines.push(l), { doFetch });
  assert.deepEqual(jobs.map((j) => j.title), ["SDET A", "SDET B"]);
  assert.deepEqual(urls.filter((u) => u.includes("t.me")), ["https://t.me/s/remote_qa_jobs", "https://t.me/s/remote_qa_jobs?before=10"], "stops on the page with no `before`, not at `pages`");
  assert.match(jobs[0].text, /Tags: qa, test automation\. Full text of A$/);
  assert.match(jobs[1].text, /Tags: qa, test automation\.$/, "the job page failed: the post summary stays");
  assert.deepEqual(Object.keys(jobs[0]).sort(), ["company", "location", "source", "text", "title", "url"], "internal fields dropped");
  assert.ok(lines.includes("  Telegram channel ok (2 jobs over 2 pages): @remote_qa_jobs"), lines.join("\n"));
  assert.ok(lines.includes("  Telegram: enriched 1/2 with the full description"), lines.join("\n"));
});

test("fetchTgChannels drops a post whose Forbidden locations name the candidate's country, before fetching its page", async () => {
  const banned = "https://boards.example/jobs/banned";
  const { urls, doFetch } = web({ channel: { "": page([
    wrap(1, post({ Title: "SDET Banned", Location: "Worldwide", Anywhere: "Yes", "Forbidden locations": "Ukraine, Russia, Belarus" }, banned)),
    wrap(2, post({ Title: "SDET Europe", Location: "Europe or Ukraine", "Forbidden locations": "Outside Europe and Ukraine" })),
  ]) } });
  const lines = [];
  const jobs = await fetchTgChannels({ enabled: true, channels: ["c"] }, (l) => lines.push(l), { doFetch, country: ["Ukraine", "Україна"] });
  assert.deepEqual(jobs.map((j) => j.title), ["SDET Europe"]);
  assert.ok(!urls.includes(banned), "no page fetch for a dropped post");
  assert.ok(lines.includes("  Telegram: dropped, forbidden locations name the candidate's country [Ukraine, Russia, Belarus]: SDET Banned"), lines.join("\n"));
});

test("fetchTgChannels: known jobs and fullDescription:false skip the job pages", async () => {
  const a = "https://boards.example/jobs/a";
  const channel = { "": page([wrap(2, post({ Title: "SDET A" }, a)), wrap(3, post({ Title: "SDET Known" }, "https://boards.example/jobs/k"))]) };
  const known = web({ channel, pages: { [a]: ld({ "@type": "JobPosting", description: "Full" }) } });
  await fetchTgChannels({ enabled: true, channels: ["c"] }, () => {}, { doFetch: known.doFetch, skip: (j) => j.title === "SDET Known" });
  assert.deepEqual(known.urls.filter((u) => !u.includes("t.me")), [a]);
  const off = web({ channel });
  await fetchTgChannels({ enabled: true, channels: ["c"], fullDescription: false }, () => {}, { doFetch: off.doFetch });
  assert.equal(off.urls.length, 1, "the channel page only");
});

test("fetchTgChannels: a group or a dead channel is reported; every channel failing throws, one failing does not", async () => {
  const { doFetch } = web({ channel: { "": "<html>a group's join page</html>" } });
  const lines = [];
  await assert.rejects(fetchTgChannels({ enabled: true, channels: ["qa_jobs"] }, (l) => lines.push(l), { doFetch }), /all 1 Telegram channel\(s\) failed/);
  assert.match(lines.join("\n"), /Telegram channel partial \(0 jobs over 0 pages\): @qa_jobs — stopped at page 1: not a public channel preview/);
  const mixed = web({ channel: { "": page([wrap(1, post({ Title: "SDET" }))]) } });
  const ok = await fetchTgChannels({ enabled: true, channels: ["good", "bad"], fullDescription: false }, () => {}, {
    doFetch: (url, init) => (url.includes("/bad") ? Promise.reject(new Error("ECONNRESET")) : mixed.doFetch(url, init)),
  });
  assert.equal(ok.length, 1);
});

test("fetchTgChannels: a channel whose first page was read is not an outage when a later page fails", async () => {
  const { doFetch } = web({ channel: { "": page([wrap(5, "Ad: join our partner program")], "5") } });
  const lines = [];
  const jobs = await fetchTgChannels({ enabled: true, channels: ["c"], pages: 2 }, (l) => lines.push(l), {
    doFetch: (url, init) => (url.includes("before=") ? Promise.reject(new Error("ECONNRESET")) : doFetch(url, init)),
  });
  assert.deepEqual(jobs, [], "page 1 held only an ad; page 2 threw — reported, not thrown");
  assert.match(lines.join("\n"), /Telegram channel error: @c — ECONNRESET/);
});

test("fetchTgChannels: off unless enabled, and no channels means no requests", async () => {
  const { urls, doFetch } = web();
  assert.deepEqual(await fetchTgChannels({ channels: ["c"] }, () => {}, { doFetch }), []);
  assert.deepEqual(await fetchTgChannels(undefined, () => {}, { doFetch }), []);
  assert.deepEqual(await fetchTgChannels({ enabled: true }, () => {}, { doFetch }), []);
  assert.equal(urls.length, 0);
});
