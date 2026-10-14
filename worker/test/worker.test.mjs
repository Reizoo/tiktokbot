// Runs the Worker with a fake Telegram, an in-memory KV and a real SQLite standing in for D1.
// The TikTok video test hits the real TikTok; the slideshow test uses a fake TikTok page.
// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../index.js";
import { findLink } from "../links.js";

const VIDEO = "https://www.tiktok.com/@tiktok/video/7694797676306615583";
const realFetch = globalThis.fetch;

// D1's prepare().bind().run()/first()/all() on top of node:sqlite.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => db.prepare(sql).run(...args),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

function setup(extraFetch) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.telegram.org/")) {
      const method = u.split("/").pop();
      const body = init.body instanceof FormData
        ? Object.fromEntries([...init.body].map(([k, v]) => [k, v instanceof Blob ? v.size : v]))
        : JSON.parse(init.body);
      calls.push({ method, body });
      return new Response('{"ok":true}');
    }
    const fake = extraFetch?.(u);
    return fake ?? realFetch(url, init);
  };
  const store = new Map();
  const env = {
    BOT_TOKEN: "1:x", WEBHOOK_SECRET: "s", PC_KEY: "k", DB: fakeD1(),
    OWNER: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) },
  };
  return { calls, env };
}

async function send(env, from, text) {
  const waits = [];
  const req = new Request("https://w/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
    body: JSON.stringify({ message: { message_id: 7, chat: { id: from }, from: { id: from }, text } }),
  });
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

const pc = (env, path, init = {}) =>
  worker.fetch(new Request(`https://w${path}`, { ...init, headers: { "X-PC-Key": "k", ...(init.headers || {}) } }), env, { waitUntil() {} });

test("links are sorted by service", () => {
  assert.equal(findLink("look https://vm.tiktok.com/ZMabc/").kind, "tiktok");
  assert.equal(findLink("https://www.youtube.com/watch?v=aqz-KE-bpKQ").kind, "youtube");
  assert.equal(findLink("https://youtu.be/aqz-KE-bpKQ?t=3").kind, "youtube");
  assert.equal(findLink("https://youtube.com/shorts/abc123").kind, "youtube");
  assert.equal(findLink("https://soundcloud.com/artist/track").kind, "soundcloud");
  assert.equal(findLink("https://on.soundcloud.com/xyz").kind, "soundcloud");
  assert.equal(findLink("hello"), null);
});

test("first /start becomes the owner, others are refused", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 222, "/start");
  await send(env, 222, VIDEO);
  assert.match(calls[0].body.text, /TikTok videos/);
  assert.equal(calls[1].body.text, "This is a private bot.");
  assert.equal(calls[2].body.text, "This is a private bot.");
});

test("a TikTok video comes back as a watermark-free upload", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 111, `look ${VIDEO} lol`);
  const video = calls.find((c) => c.method === "sendVideo");
  assert.ok(video, JSON.stringify(calls));
  assert.ok(video.body.video > 1_000_000);
  assert.match(video.body.caption, /^@tiktok/);
});

test("a TikTok slideshow comes back as albums of 10 plus the sound", async () => {
  const images = Array.from({ length: 12 }, (_, i) => ({ imageURL: { urlList: [`https://p.example/img${i}.webp`, `https://p.example/img${i}.jpeg`] } }));
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: { id: "1", desc: "trip", author: { uniqueId: "amy" }, imagePost: { images }, music: { playUrl: "https://p.example/sound.mp3", title: "song", authorName: "band" } } } } },
  })}</script>`;
  const { calls, env } = setup((u) => {
    if (u.startsWith("https://www.tiktok.com/")) return new Response(page, { headers: { "set-cookie": "tt_chain_token=a" } });
    if (u.startsWith("https://p.example/")) return new Response(new Uint8Array(500), { headers: { "content-type": u.endsWith(".mp3") ? "audio/mpeg" : "image/jpeg" } });
  });
  await send(env, 111, "/start");
  await send(env, 111, "https://www.tiktok.com/@amy/photo/1");
  const albums = calls.filter((c) => c.method === "sendMediaGroup");
  assert.equal(albums.length, 2);
  assert.equal(JSON.parse(albums[0].body.media).length, 10);
  assert.equal(JSON.parse(albums[1].body.media).length, 2);
  assert.equal(JSON.parse(albums[0].body.media)[0].caption, "@amy · trip");
  const audio = calls.find((c) => c.method === "sendAudio");
  assert.equal(audio.body.title, "song");
});

test("YouTube and SoundCloud links are queued for the PC, which claims and finishes them", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 111, "https://youtube.com/shorts/abc123");
  assert.match(calls.at(-1).body.text, /PC is off/);

  const first = await (await pc(env, "/pc/jobs")).json();
  assert.equal(first.jobs.length, 1);
  assert.equal(first.jobs[0].kind, "youtube");
  assert.equal(first.jobs[0].reply_to, 7);
  assert.equal((await (await pc(env, "/pc/jobs")).json()).jobs.length, 0, "a claimed job isn't handed out twice");

  await send(env, 111, "https://soundcloud.com/artist/track");
  assert.match(calls.at(-1).body.text, /Downloading on the PC/, "the PC just polled, so it counts as on");

  await pc(env, "/pc/done", { method: "POST", body: JSON.stringify({ id: first.jobs[0].id, ok: true }) });
  assert.equal(env.DB.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(first.jobs[0].id).status, "done");
});

test("wrong secrets are rejected", async () => {
  const { env } = setup();
  const hook = await worker.fetch(new Request("https://w/webhook", { method: "POST", body: "{}" }), env, { waitUntil() {} });
  assert.equal(hook.status, 403);
  const jobs = await worker.fetch(new Request("https://w/pc/jobs", { headers: { "X-PC-Key": "nope" } }), env, { waitUntil() {} });
  assert.equal(jobs.status, 403);
});
