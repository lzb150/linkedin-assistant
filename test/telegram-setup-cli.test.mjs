// telegram-setup.mjs as a black box against a fake Bot API (TELEGRAM_API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { makeProject, spawnScript, startBotApi } from "./helpers/e2e.mjs";

const TOKEN = "123456:ABC-def_ghi";
const update = (id, chat) => ({ update_id: id, message: { message_id: id, chat, text: "hi" } });

// getMe names the bot, getUpdates returns `updates`, sendMessage succeeds.
const fakeBot = (updates) => (_n, path) => {
  if (path.endsWith("/getMe")) return [200, { ok: true, result: { id: 1, is_bot: true, username: "my_jobs_bot" } }];
  if (path.endsWith("/getUpdates")) return [200, { ok: true, result: updates }];
  return [200, { ok: true, result: {} }];
};

test("telegram-setup.mjs: saves the chat you messaged the bot from and sends a confirmation there", async (t) => {
  const api = await startBotApi(t, fakeBot([
    update(1, { id: 555, type: "private" }),
    update(2, { id: -100, type: "group" }),
    update(3, { id: 777, type: "private", first_name: "Eu\u001b[2Jgene", username: "lzb" }),
  ]));
  const p = makeProject(t, { scripts: ["telegram-setup.mjs"] });
  const out = await spawnScript(p, "telegram-setup.mjs", { TELEGRAM_API: api.base }, [TOKEN]).done;
  assert.match(out, /chat 777: Eu\[2Jgene \(@lzb\)\)\. Not you\?/, "names whoever the alerts go to");
  assert.ok(!out.includes("\u001b"), "a sender's name cannot drive the terminal");
  assert.deepEqual(p.json("telegram.json"), { token: TOKEN, chatId: 777, apiBase: api.base }, "the newest private chat, not the group");
  assert.equal(statSync(p.path("telegram.json")).mode & 0o777, 0o600, "the token is readable by you alone");
  const sent = api.calls.find((c) => c.path.endsWith("/sendMessage"));
  assert.equal(sent?.body.chat_id, 777);
  assert.equal(api.calls[0].path, `/bot${TOKEN}/getMe`);
  assert.doesNotMatch(out, /ABC-def_ghi/, "the token is not echoed to the terminal");
});

test("telegram-setup.mjs: with no message to the bot yet it says where to write and saves nothing", async (t) => {
  const api = await startBotApi(t, fakeBot([]));
  const p = makeProject(t, { scripts: ["telegram-setup.mjs"] });
  await assert.rejects(spawnScript(p, "telegram-setup.mjs", { TELEGRAM_API: api.base }, [TOKEN]).done, /exit 1[\s\S]*https:\/\/t\.me\/my_jobs_bot/);
  assert.equal(existsSync(p.path("telegram.json")), false);
});

test("telegram-setup.mjs: a token Telegram rejects saves nothing", async (t) => {
  const api = await startBotApi(t, () => [401, { ok: false, description: "Unauthorized" }]);
  const p = makeProject(t, { scripts: ["telegram-setup.mjs"] });
  await assert.rejects(spawnScript(p, "telegram-setup.mjs", { TELEGRAM_API: api.base }, [TOKEN]).done, /exit 1[\s\S]*rejected/);
  assert.equal(existsSync(p.path("telegram.json")), false);
});

test("telegram-setup.mjs: something that is not a bot token is refused before any request", async (t) => {
  const api = await startBotApi(t);
  const p = makeProject(t, { scripts: ["telegram-setup.mjs"] });
  await assert.rejects(spawnScript(p, "telegram-setup.mjs", { TELEGRAM_API: api.base }, ["../../etc"]).done, /exit 1/);
  assert.equal(api.calls.length, 0);
});
