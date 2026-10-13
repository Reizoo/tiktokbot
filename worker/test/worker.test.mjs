// Runs the Worker with a fake Telegram and KV (TikTok is real): node --test test/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../index.js";

const VIDEO = "https://www.tiktok.com/@tiktok/video/7694797676306615583";
const realFetch = globalThis.fetch;

function setup() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      const method = String(url).split("/").pop();
      const body = init.body instanceof FormData ? Object.fromEntries([...init.body].map(([k, v]) => [k, v instanceof Blob ? v.size : v])) : JSON.parse(init.body);
      calls.push({ method, body });
      return new Response('{"ok":true}');
    }
    return realFetch(url, init);
  };
  const store = new Map();
  const env = { BOT_TOKEN: "1:x", WEBHOOK_SECRET: "s", OWNER: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) } };
  return { calls, env };
}

async function send(env, from, text) {
  const waits = [];
  const req = new Request("https://w/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify({ message: { message_id: 1, chat: { id: from }, from: { id: from }, text } }) });
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

test("first /start becomes the owner, others are refused", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 222, "/start");
  await send(env, 222, VIDEO);
  assert.match(calls[0].body.text, /Send me a TikTok link/);
  assert.equal(calls[1].body.text, "This is a private bot.");
  assert.equal(calls[2].body.text, "This is a private bot.");
});

test("a TikTok link comes back as a watermark-free video upload", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 111, `look ${VIDEO} lol`);
  const video = calls.find((c) => c.method === "sendVideo");
  assert.ok(video, JSON.stringify(calls));
  assert.ok(video.body.video > 1_000_000);
  assert.match(video.body.caption, /^@tiktok/);
});

test("wrong secret is rejected", async () => {
  const { env } = setup();
  const res = await worker.fetch(new Request("https://w/webhook", { method: "POST", body: "{}" }), env, { waitUntil() {} });
  assert.equal(res.status, 403);
});
