// Telegram copy of the alerts, for when you are away from the Mac. Opt-in and
// personal: telegram.json at the project root ({"token": "<BotFather token>",
// "chatId": <your chat id>}, gitignored, written by `node telegram-setup.mjs`)
// turns it on. Without it every call here is a no-op.
//
// Messages are queued as files in telegram-outbox/ and posted by a detached
// lib/telegram-send.mjs, never inline: every caller process.exit()s right after
// its banner, which would cut a fetch short, and a Mac that has just woken often
// has no network yet. A queued message waits for the next drain instead of
// being lost. The token lives only in telegram.json, never in the environment,
// so the LLM subprocess that reads untrusted job text never inherits it.
import { readFileSync, readdirSync, mkdirSync, unlinkSync, openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeTextAtomic } from "./json-file.mjs";
import { isHttpUrl } from "./filters.mjs";
import { localDay } from "./local-day.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = join(ROOT, "telegram.json");
export const OUTBOX = join(ROOT, "telegram-outbox");
const API = "https://api.telegram.org";
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;   // an alert two days late is noise, not news
const TIMEOUT_MS = 15_000;
const MAX_429_RETRIES = 3;

import { log } from "./log.mjs";   // not notify.mjs's: notify.mjs imports this module
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram HTML: these four are the only characters that need escaping.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// One line, bounded: scraped fields carry newlines (raw RSS titles) and have no
// length limit, and a message over 4096 characters is rejected outright.
// Shared with the banner text (check.mjs, djinni-bump.mjs) for the same reason.
export const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const SOURCE = { dou: "DOU", djinni: "Djinni", himalayas: "Himalayas", tgchannels: "Telegram", linkedin: "LinkedIn" };

// { token, chatId, apiBase } or null (off). A missing file is the normal "off";
// a broken one is logged, because a typo must not silently stop the alerts.
export function readTelegramConfig(file = CONFIG, { log: say = log } = {}) {
  let c;
  try { c = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    if (e.code !== "ENOENT") say(`telegram: ${file} unreadable (${e.message}) — Telegram alerts off`);
    return null;
  }
  if (!c?.token || !c?.chatId) return null;
  return { token: c.token, chatId: c.chatId, apiBase: c.apiBase || API };
}

// Queue one HTML message and kick the sender. false when Telegram is off or the
// queue write failed (logged). Never throws: an alert must not break a scan.
let seq = 0;   // keeps messages queued within one millisecond in order
export function queueTelegram(html, { config = CONFIG, dir = OUTBOX, start = startSender, log: say = log } = {}) {
  if (!readTelegramConfig(config, { log: say })) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${String(seq++).padStart(6, "0")}-${randomUUID()}.json`;
    writeTextAtomic(join(dir, name), JSON.stringify({ html }));
  } catch (e) {
    say("telegram: queueing failed:", e?.message);
    return false;
  }
  kickSender(start);
  return true;
}

// One sender per burst, not one per message: a scan with N matches used to
// spawn N `caffeinate node telegram-send.mjs`, N-1 of which only found the
// outbox lock busy. The first queue call arms an unref'd timer; the sender it
// starts re-checks the outbox after its drain, so one start after the last
// queue call delivers every message. Every caller process.exit()s right after
// its banner, which skips the timer: the exit hook starts the sender then
// (spawn is synchronous, so it is allowed there); beforeExit covers a process
// that just runs out of work, where the unref'd timer never fires.
const SENDER_DEBOUNCE_MS = 1000;
let flushSender = null;   // starts the pending sender now; null = none pending
function kickSender(start) {
  if (flushSender) return;
  const timer = setTimeout(() => flushSender?.(), SENDER_DEBOUNCE_MS);
  timer.unref();
  flushSender = () => { clearTimeout(timer); flushSender = null; start(); };
}
process.on("exit", () => flushSender?.());
process.on("beforeExit", () => flushSender?.());

// Post every queued message, oldest first, deleting each once Telegram accepts
// it. Stops (keeping the rest for the next drain) on a network failure or a
// 5xx ("network"), a bad token, blocked bot or wrong chat id ("config"), or a
// sent or dropped message it cannot delete ("fs" — re-draining would post it again).
// A message Telegram rejects for its content (any other 4xx) is dropped.
export async function drainOutbox({
  config = CONFIG, dir = OUTBOX, fetch: post = globalThis.fetch, now = Date.now,
  sleep = sleepMs, log: say = log, maxAgeMs = MAX_AGE_MS,
} = {}) {
  const r = { sent: 0, dropped: 0, stopped: null };
  const cfg = readTelegramConfig(config, { log: say });
  if (!cfg) return { ...r, stopped: "config" };
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return r; }
  const hide = (s) => String(s).split(cfg.token).join("<token>");
  const stop = (why, kind) => { say(`telegram: ${hide(why)} — queued messages kept for the next drain`); r.stopped = kind; return r; };

  for (const f of files) {
    const path = join(dir, f);
    // false = the file is still there: the drain stops ("fs") like a sent
    // message it cannot remove. Counting it as dropped anyway read as progress
    // to the sender loop, which re-drained (and re-posted a rejected message)
    // up to MAX_ROUNDS times without a pause.
    const drop = (why) => {
      say(`telegram: dropped ${f} — ${hide(why)}`);
      try { unlinkSync(path); } catch (e) { stop(`dropped ${f} but could not remove it (${e.message})`, "fs"); return false; }
      r.dropped++;
      return true;
    };
    if (now() - Number(f.split("-")[0]) > maxAgeMs) { if (!drop("queued more than two days ago")) return r; continue; }
    let html;
    try { html = JSON.parse(readFileSync(path, "utf8")).html; } catch (e) {
      if (e.code !== "ENOENT" && !drop(`unreadable (${e.message})`)) return r;
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      let res, body;
      try {
        res = await post(`${cfg.apiBase}/bot${cfg.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        return stop(`send failed (${e?.cause?.message || e?.message})`, "network");
      }
      const what = `${res.status} ${body?.description || ""}`.trim();
      if (res.ok) {
        r.sent++;
        try { unlinkSync(path); } catch (e) { return stop(`sent ${f} but could not remove it (${e.message})`, "fs"); }
        break;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        await sleep(Math.min(Number(body?.parameters?.retry_after) || 1, 60) * 1000);
        continue;
      }
      if ([401, 403, 404].includes(res.status) || /chat not found/i.test(body?.description || "")) {
        return stop(`${what} — check telegram.json (re-run node telegram-setup.mjs)`, "config");
      }
      if (res.status === 429 || res.status >= 500) return stop(what, "network");
      if (!drop(what)) return r;
      break;
    }
  }
  return r;
}

// Detached, so the caller's process.exit() does not kill the send. Under
// caffeinate on macOS: a DarkWake run's Mac would otherwise sleep mid-send.
export function startSender({ root = ROOT, platform = process.platform, log: say = log } = {}) {
  let fd;
  try {
    mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
    fd = openSync(join(root, "logs", `telegram_${localDay().replaceAll("-", "")}.log`), "a", 0o600);
    const node = [process.execPath, join(root, "lib", "telegram-send.mjs")];
    const [cmd, ...args] = platform === "darwin" ? ["/usr/bin/caffeinate", "-i", ...node] : node;
    const p = spawn(cmd, args, { cwd: root, detached: true, stdio: ["ignore", fd, fd] });
    p.on("error", (e) => say("telegram: sender failed to start:", e?.message));
    p.unref();
  } catch (e) {
    say("telegram: sender failed to start:", e?.message);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// One vacancy: the title links to it, then company · location · board,
// salary, the LLM verdict (or the keyword score when the LLM did not judge)
// and its red flags.
export function jobMessage({ title, company, location, source, url, salary, score, llmScore, why, redFlags }) {
  const name = `<b>${esc(clip(title, 200))}</b>`;
  const lines = [isHttpUrl(url) ? `<a href="${esc(url)}">${name}</a>` : name];
  lines.push([clip(company, 100), clip(location, 100), SOURCE[source] || clip(source, 30)].filter(Boolean).map(esc).join(" · "));
  if (salary) lines.push(`💰 ${esc(clip(salary, 60))}`);
  lines.push(llmScore != null
    ? `⭐ ${llmScore}${why ? ` — ${esc(clip(why, 300))}` : ""}`
    : `⭐ keyword ${score}`);
  if (Array.isArray(redFlags) && redFlags.length) lines.push(`⚠ ${esc(clip(redFlags.join("; "), 600))}`);
  return lines.join("\n");
}

// A banner's text, with an optional "Open" link (http(s) only).
export function alertMessage(title, message, link) {
  const open = isHttpUrl(link) ? `\n<a href="${esc(link)}">Open</a>` : "";
  return `<b>${esc(clip(title, 100))}</b>\n${esc(String(message ?? "").slice(0, 3500))}${open}`;
}
