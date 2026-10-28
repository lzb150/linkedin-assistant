import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBotApi as botApi } from "./helpers/e2e.mjs";
import { readTelegramConfig, queueTelegram, drainOutbox, jobMessage, alertMessage, startSender } from "../lib/telegram.mjs";
import { localDay } from "../lib/local-day.mjs";

const DAY = 24 * 60 * 60 * 1000;
const quiet = () => {};

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A configured project: telegram.json pointing at `apiBase`, and an outbox
// holding `files` ([name, html] pairs; the name's leading number is its queue time).
function setup(t, apiBase, files = []) {
  const dir = tmp(t);
  const config = join(dir, "telegram.json");
  writeFileSync(config, JSON.stringify({ token: "123:SECRET", chatId: "42", apiBase }));
  const outbox = join(dir, "outbox");
  mkdirSync(outbox);
  for (const [name, html] of files) writeFileSync(join(outbox, name), JSON.stringify({ html }));
  return { config, outbox };
}

test("readTelegramConfig: off unless both a token and a chat id are set", (t) => {
  const f = join(tmp(t), "telegram.json");
  const logs = [];
  const say = (...a) => logs.push(a.join(" "));
  assert.equal(readTelegramConfig(f, { log: say }), null, "missing file");
  assert.deepEqual(logs, [], "a missing file is the normal \"off\", not worth a log line");
  writeFileSync(f, "{not json");
  assert.equal(readTelegramConfig(f, { log: say }), null, "unparsable");
  assert.equal(logs.length, 1, "a broken telegram.json says so instead of going quiet");
  writeFileSync(f, JSON.stringify({ token: "1:a" }));
  assert.equal(readTelegramConfig(f), null, "no chat id");
  writeFileSync(f, JSON.stringify({ chatId: 42 }));
  assert.equal(readTelegramConfig(f), null, "no token");
  writeFileSync(f, JSON.stringify({ token: "1:a", chatId: 42 }));
  assert.deepEqual(readTelegramConfig(f), { token: "1:a", chatId: 42, apiBase: "https://api.telegram.org" });
});

test("queueTelegram: without a config it queues nothing and starts no sender", (t) => {
  const dir = tmp(t);
  let started = 0;
  const queued = queueTelegram("x", { config: join(dir, "none.json"), dir: join(dir, "outbox"), start: () => started++ });
  assert.equal(queued, false);
  assert.equal(existsSync(join(dir, "outbox")), false);
  assert.equal(started, 0);
});

test("queueTelegram: one file per message, in queue order even within one millisecond, and ONE sender start per burst", async (t) => {
  // A scan with N matches used to start N senders, N-1 of which only found
  // the outbox lock busy; the one sender re-checks the outbox after its drain.
  const { config, outbox } = setup(t, "http://unused");
  let started = 0;
  for (const html of ["first", "second", "third"]) queueTelegram(html, { config, dir: outbox, start: () => started++ });
  const queued = readdirSync(outbox).sort().map((f) => JSON.parse(readFileSync(join(outbox, f), "utf8")).html);
  assert.deepEqual(queued, ["first", "second", "third"]);
  assert.equal(started, 0, "the start is debounced, not immediate");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(started, 1);
});

test("queueTelegram: an unwritable outbox is logged, never thrown", (t) => {
  const { config } = setup(t, "http://unused");
  const file = join(tmp(t), "a-file");
  writeFileSync(file, "");
  const logs = [];
  const queued = queueTelegram("x", { config, dir: join(file, "outbox"), start: quiet, log: (...a) => logs.push(a.join(" ")) });
  assert.equal(queued, false);
  assert.equal(logs.length, 1);
});

test("drainOutbox: posts each queued message to sendMessage, oldest first, and removes it", async (t) => {
  const api = await botApi(t);
  const { config, outbox } = setup(t, api.base, [["2000-0001-b.json", "second"], ["1000-0001-a.json", "first"]]);
  const r = await drainOutbox({ config, dir: outbox, now: () => 3000, log: quiet });
  assert.deepEqual(api.calls.map((c) => c.body.text), ["first", "second"]);
  assert.equal(api.calls[0].path, "/bot123:SECRET/sendMessage");
  assert.equal(api.calls[0].type, "application/json");
  assert.deepEqual(api.calls[0].body, { chat_id: "42", text: "first", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  assert.deepEqual(readdirSync(outbox), []);
  assert.deepEqual(r, { sent: 2, dropped: 0, stopped: null });
});

test("drainOutbox: an unreachable API stops the drain and keeps every message for the next one", async (t) => {
  const { config, outbox } = setup(t, "http://127.0.0.1:9", [["1000-0001-a.json", "a"], ["1000-0002-b.json", "b"]]);
  const logs = [];
  const r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: (...a) => logs.push(a.join(" ")) });
  assert.equal(r.stopped, "network");
  assert.equal(readdirSync(outbox).length, 2);
  assert.ok(logs.length > 0, "the failure is logged");
  assert.doesNotMatch(logs.join("\n"), /SECRET/, "the bot token never reaches the log");
});

test("drainOutbox: a message Telegram rejects (400) is dropped and the rest still go out", async (t) => {
  const api = await botApi(t, (n) => (n === 1 ? [400, { ok: false, description: "Bad Request: can't parse entities" }] : [200, { ok: true }]));
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "bad"], ["1000-0002-b.json", "good"]]);
  const r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet });
  assert.deepEqual(api.calls.map((c) => c.body.text), ["bad", "good"]);
  assert.deepEqual(readdirSync(outbox), []);
  assert.deepEqual(r, { sent: 1, dropped: 1, stopped: null });
});

test("drainOutbox: 429 waits retry_after seconds and sends the same message again", async (t) => {
  const api = await botApi(t, (n) => (n === 1 ? [429, { ok: false, parameters: { retry_after: 3 } }] : [200, { ok: true }]));
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "a"]]);
  const waits = [];
  const r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000]);
  assert.deepEqual(api.calls.map((c) => c.body.text), ["a", "a"]);
  assert.deepEqual(readdirSync(outbox), []);
  assert.equal(r.sent, 1);
});

test("drainOutbox: a rejected token (401) stops the drain and keeps the messages", async (t) => {
  const api = await botApi(t, () => [401, { ok: false, description: "Unauthorized" }]);
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "a"], ["1000-0002-b.json", "b"]]);
  const r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet });
  assert.equal(r.stopped, "config");
  assert.equal(api.calls.length, 1, "no point trying the rest with a bad token");
  assert.equal(readdirSync(outbox).length, 2);
});

test("drainOutbox: a wrong chat id (400 chat not found) stops the drain instead of dropping every message", async (t) => {
  const api = await botApi(t, () => [400, { ok: false, description: "Bad Request: chat not found" }]);
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "a"], ["1000-0002-b.json", "b"]]);
  const r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet });
  assert.equal(r.stopped, "config");
  assert.equal(readdirSync(outbox).length, 2);
});

test("drainOutbox: a sent message that cannot be removed stops the drain, so it is not posted again and again", { skip: process.getuid?.() === 0 && "root ignores directory permissions" }, async (t) => {
  const api = await botApi(t);
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "a"], ["1000-0002-b.json", "b"]]);
  chmodSync(outbox, 0o500);
  let r;
  try { r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet }); }
  finally { chmodSync(outbox, 0o700); }   // here, not in t.after: the temp-dir cleanup hook runs first
  assert.equal(r.stopped, "fs");
  assert.equal(api.calls.length, 1);
  assert.equal(r.sent, 1);
});

test("drainOutbox: a rejected message that cannot be removed stops the drain instead of counting as progress", { skip: process.getuid?.() === 0 && "root ignores directory permissions" }, async (t) => {
  // `dropped++` on a file still in the outbox told the sender loop it was
  // getting somewhere: it re-drained (re-posting the rejected message) up to
  // MAX_ROUNDS times with no pause.
  const api = await botApi(t, () => [400, { ok: false, description: "Bad Request: can't parse entities" }]);
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "bad"], ["1000-0002-b.json", "also bad"]]);
  chmodSync(outbox, 0o500);
  let r;
  try { r = await drainOutbox({ config, dir: outbox, now: () => 2000, log: quiet }); }
  finally { chmodSync(outbox, 0o700); }   // here, not in t.after: the temp-dir cleanup hook runs first
  assert.equal(r.stopped, "fs");
  assert.equal(r.dropped, 0, "a file still in the outbox is not a drop");
  assert.equal(api.calls.length, 1, "the second message is left for a drain that can remove files");
  assert.equal(readdirSync(outbox).length, 2);
});

test("drainOutbox: a message queued more than two days ago is dropped unsent", async (t) => {
  const api = await botApi(t);
  const { config, outbox } = setup(t, api.base, [["1000-0001-a.json", "stale"], [`${3 * DAY}-0001-b.json`, "fresh"]]);
  const r = await drainOutbox({ config, dir: outbox, now: () => 3 * DAY + 1000, log: quiet });
  assert.deepEqual(api.calls.map((c) => c.body.text), ["fresh"]);
  assert.deepEqual(readdirSync(outbox), []);
  assert.deepEqual(r, { sent: 1, dropped: 1, stopped: null });
});

test("jobMessage: the title links to the vacancy and every scraped field is escaped", () => {
  const html = jobMessage({
    title: "QA <Lead> & co", company: "Acme", location: "Remote", source: "dou",
    url: "https://jobs.dou.ua/v/1/?a=1&b=2", salary: "$4000–5000",
    score: 40, llmScore: 82, why: "Playwright <fit>", redFlags: ["on-site", "C#"],
  });
  assert.equal(html, [
    `<a href="https://jobs.dou.ua/v/1/?a=1&amp;b=2"><b>QA &lt;Lead&gt; &amp; co</b></a>`,
    "Acme · Remote · DOU",
    "💰 $4000–5000",
    "⭐ 82 — Playwright &lt;fit&gt;",
    "⚠ on-site; C#",
  ].join("\n"));
});

test("jobMessage: no link for a non-http url, and the keyword score when the LLM did not judge", () => {
  const html = jobMessage({ title: "SDET", company: "Acme", source: "djinni", url: "javascript:alert(1)", score: 40, llmScore: null });
  assert.equal(html, "<b>SDET</b>\nAcme · Djinni\n⭐ keyword 40");
});

test("alertMessage: bold title, escaped text and an optional link", () => {
  assert.equal(
    alertMessage("LinkedIn", "Ann <HR>: hi", "https://www.linkedin.com/messaging/thread/abc/"),
    `<b>LinkedIn</b>\nAnn &lt;HR&gt;: hi\n<a href="https://www.linkedin.com/messaging/thread/abc/">Open</a>`,
  );
  assert.equal(alertMessage("Djinni", "Profile bumped"), "<b>Djinni</b>\nProfile bumped");
  assert.equal(alertMessage("Djinni", "x", "file:///etc/passwd"), "<b>Djinni</b>\nx", "only http(s) links");
});

test("jobMessage: the posting's age joins the company line and a repost gets its own line", () => {
  const posted = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const html = jobMessage({ title: "SDET", company: "Acme", source: "djinni", url: "https://djinni.co/jobs/1-x/", score: 40, llmScore: 80, posted, reposts: 2 });
  assert.equal(html.split("\n")[1], "Acme · Djinni · posted 3 d ago");
  assert.equal(html.split("\n")[2], "🔁 reposted ×2 — the board closed the earlier listing");
  assert.doesNotMatch(jobMessage({ title: "SDET", company: "Acme", source: "djinni", url: "https://djinni.co/jobs/1-x/", score: 40, llmScore: null, posted: "garbage", reposts: 0 }), /posted|reposted/);
});

// The sender is a detached `node lib/telegram-send.mjs` writing into the day's
// telegram log. A root without that script makes the child fail at once, and
// its "Cannot find module" lands in the log — proof the child really started
// with the log as its stdout/stderr.
async function senderLog(root, before) {
  const names = [before, localDay()].map((d) => `telegram_${d.replaceAll("-", "")}.log`);
  for (let i = 0; i < 60; i++) {
    for (const n of names) {
      const file = join(root, "logs", n);
      if (existsSync(file) && readFileSync(file, "utf8").includes("Cannot find module")) return n;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test("startSender: starts the detached sender with the day's telegram log as its output, creating logs/ on a fresh root", async (t) => {
  const root = join(tmp(t), "fresh", "root"), logs = [], before = localDay();   // nothing exists yet: logs/ needs a recursive mkdir
  startSender({ root, platform: "linux", log: (...a) => logs.push(a.join(" ")) });
  assert.match(await senderLog(root, before) || "", /^telegram_\d{8}\.log$/, "the child wrote into logs/telegram_YYYYMMDD.log");
  assert.deepEqual(logs, [], "no start failure reported");
});

test("startSender: on macOS the sender runs under caffeinate so a DarkWake run does not sleep mid-send", { skip: !existsSync("/usr/bin/caffeinate") && "no /usr/bin/caffeinate here" }, async (t) => {
  const root = tmp(t), logs = [], before = localDay();
  startSender({ root, platform: "darwin", log: (...a) => logs.push(a.join(" ")) });
  assert.ok(await senderLog(root, before), "caffeinate ran the sender, whose error reached the log");
  assert.deepEqual(logs, []);
});

test("startSender: a logs dir it cannot create is reported, never thrown", (t) => {
  const root = join(tmp(t), "not-a-dir");
  writeFileSync(root, "");   // logs/ under a regular file: ENOTDIR
  const logs = [];
  assert.doesNotThrow(() => startSender({ root, platform: "linux", log: (...a) => logs.push(a.join(" ")) }));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^telegram: sender failed to start: ENOTDIR/);
});
