// One-time setup for the Telegram copy of the alerts (lib/telegram.mjs).
//   1. In Telegram, open @BotFather, send /newbot and pick a name.
//   2. Send your new bot any message (a bot cannot write to you first).
//   3. node telegram-setup.mjs — it asks for the token from BotFather (typed, not
//      echoed). TELEGRAM_BOT_TOKEN=<token> node telegram-setup.mjs skips the prompt.
//      A token passed as an argument works too but shows up in `ps` and shell history.
// Finds your chat from that message, sends a test message there and writes
// telegram.json (0600, gitignored). Re-run it to change the bot or the chat;
// delete telegram.json to turn the alerts off.
// TELEGRAM_API points it at another Bot API server (self-hosted, or a test fake).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { writeJsonAtomic } from "./lib/json-file.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const API = process.env.TELEGRAM_API || "https://api.telegram.org";
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// The token stays out of `ps` and shell history: environment, else a prompt
// with echo off. An argument still works, with a warning.
async function readToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  if (process.argv[2]) {
    console.error("! a token in the command line shows up in `ps` and shell history — prefer the prompt or TELEGRAM_BOT_TOKEN");
    return process.argv[2];
  }
  if (!process.stdin.isTTY) return "";
  let muted = false;
  const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stderr.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write("Bot token from @BotFather: ");
  muted = true;
  try { return await rl.question(""); } catch { return ""; } finally { rl.close(); process.stderr.write("\n"); }
}
const token = (await readToken()).trim();

// Shape check before any request: the token becomes part of the URL path.
if (!/^\d+:[\w-]+$/.test(token)) fail("no valid bot token — run node telegram-setup.mjs and paste the token from @BotFather at the prompt, or set TELEGRAM_BOT_TOKEN (it looks like 123456789:AAH…)");

async function call(method, body = {}) {
  const { res, json } = await post(method, body);
  if (!res.ok || !json.ok) fail(`${method}: ${res.status} ${json.description || ""}`.trim());
  return json.result;
}

// One request with this token: the response and its JSON body ({} when it has
// none). Telegram out of reach, or refusing the token itself, ends the setup.
async function post(method, body) {
  let res, json;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    fail(`could not reach Telegram (${e?.cause?.message || e?.message})`);
  }
  if (res.status === 401) fail("Telegram rejected the token — copy it again from @BotFather");
  return { res, json };
}

const me = await call("getMe");
// Newest first, private chats only: the bot may also sit in a group.
const chat = [...(await call("getUpdates"))].reverse().map((u) => u.message?.chat).find((c) => c?.type === "private");
if (!chat) fail(`no message to the bot yet — open https://t.me/${me.username}, send it any message, then run this again`);

// The chat is whoever messaged the bot last: a stranger who found the bot by
// its username shortly before this run would get every alert. Name them and,
// at a terminal, ask before anything is sent or saved.
// Control and format characters go — the name is theirs and prints to a terminal.
const who = [chat.first_name, chat.last_name].filter(Boolean).join(" ") + (chat.username ? ` (@${chat.username})` : "");
const name = who.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80) || "no name";
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Send the alerts to chat ${chat.id}: ${name}? [y/N] `).catch(() => "");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail("nothing saved — send the bot a message yourself and run this again");
}

// Test message first: a config is only saved once it has been shown to work.
await call("sendMessage", { chat_id: chat.id, text: "✅ linkedin-assistant: Telegram alerts are on. New matching jobs and recruiter messages will arrive here." });
writeJsonAtomic(join(__dir, "telegram.json"), { token, chatId: chat.id, ...(process.env.TELEGRAM_API ? { apiBase: API } : {}) }, 2);   // 0600
console.log(`✓ telegram.json written — alerts go to @${me.username} (chat ${chat.id}: ${name}). Not you? Delete telegram.json, send the bot a message yourself and run this again. Check Telegram for the test message.`);
