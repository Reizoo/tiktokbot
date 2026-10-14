// Runs the Worker with a fake Telegram, an in-memory KV and a real SQLite standing in for D1.
// The TikTok video test hits the real TikTok; the slideshow test uses a fake TikTok page.
// npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../index.js";
import { findLink } from "../links.js";
import { rankTracks, downloadable } from "../rank.js";

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
      if (method === "getMe") return Response.json({ ok: true, result: { supports_inline_queries: true } });
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

test("search results: the real song beats speed-ups and remixes, DRM-only tracks are dropped", () => {
  const hls = { media: { transcodings: [{ snipped: false, format: { protocol: "hls" } }] } };
  const tracks = [
    { title: "Artist - Song (speed up)", user: { username: "fan" }, playback_count: 3000, ...hls },
    { title: "Artist - Song [someone remix]", user: { username: "dj" }, playback_count: 9000, ...hls },
    { title: "Song", user: { username: "Artist", verified: true }, publisher_metadata: { artist: "Artist" }, playback_count: 2800000, ...hls },
  ];
  assert.equal(rankTracks("song artist", tracks)[0].title, "Song");
  assert.equal(rankTracks("artist song speed up", tracks)[0].title, "Artist - Song (speed up)", "asked for the speed-up");
  assert.equal(downloadable({ media: { transcodings: [{ snipped: false, format: { protocol: "ctr-encrypted-hls" } }] } }), false);
});

test("first /start becomes the owner, others are refused", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 222, "/start");
  await send(env, 222, VIDEO);
  assert.ok(calls.some((c) => c.method === "getWebhookInfo"), "/start checks the webhook");
  assert.ok(!calls.some((c) => c.method === "sendMessage" && /Inline search is off/.test(c.body.text)), "no warning when inline mode is on");
  const welcome = calls.filter((c) => c.method === "sendMessage");
  assert.match(welcome[0].body.text, /TikTok videos/);
  assert.equal(welcome[1].body.text, "This is a private bot.");
  assert.equal(welcome[2].body.text, "This is a private bot.");
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

test("a SoundCloud track comes back as audio, joined from its HLS segments", async () => {
  const { calls, env } = setup((u) => {
    if (u === "https://soundcloud.com/") return new Response('<script crossorigin src="https://a-v2.sndcdn.com/assets/app.js"></script>');
    if (u.startsWith("https://a-v2.sndcdn.com/")) return new Response('x={client_id:"abcdefghijklmnopqrstuvwxyz123456"}');
    if (u.startsWith("https://api-v2.soundcloud.com/resolve")) return Response.json({
      kind: "track", title: "Song", user: { username: "Band" }, duration: 61000, track_authorization: "t",
      media: { transcodings: [{ url: "https://api-v2.soundcloud.com/media/1/aac", preset: "aac_96k", snipped: false, format: { protocol: "hls", mime_type: 'audio/mp4; codecs="mp4a.40.2"' } }] },
    });
    if (u.startsWith("https://api-v2.soundcloud.com/media/")) return Response.json({ url: "https://cf-hls.example/list.m3u8" });
    if (u === "https://cf-hls.example/list.m3u8") {
      return new Response(['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10,", "seg1.m4s", "#EXTINF:10,", "seg2.m4s", "#EXT-X-ENDLIST", ""].join("\n"));
    }
    if (u.startsWith("https://cf-hls.example/")) return new Response(new Uint8Array(1000));
  });
  await send(env, 111, "/start");
  await send(env, 111, "https://soundcloud.com/band/song");
  const audio = calls.find((c) => c.method === "sendAudio");
  assert.ok(audio, JSON.stringify(calls));
  assert.equal(audio.body.audio, 3000, "init + 2 segments");
  assert.equal(audio.body.title, "Song");
  assert.equal(audio.body.performer, "Band");
  assert.equal(audio.body.duration, "61");
});

test("YouTube links are queued for the PC, which claims and finishes them", async () => {
  const { calls, env } = setup();
  await send(env, 111, "/start");
  await send(env, 111, "https://youtube.com/shorts/abc123");
  assert.match(calls.at(-1).body.text, /PC is off/);

  const first = await (await pc(env, "/pc/jobs")).json();
  assert.equal(first.jobs.length, 1);
  assert.equal(first.jobs[0].kind, "youtube");
  assert.equal(first.jobs[0].reply_to, 7);
  assert.equal((await (await pc(env, "/pc/jobs")).json()).jobs.length, 0, "a claimed job isn't handed out twice");

  await send(env, 111, "https://youtu.be/aqz-KE-bpKQ");
  assert.match(calls.at(-1).body.text, /Downloading on the PC/, "the PC just polled, so it counts as on");

  await pc(env, "/pc/done", { method: "POST", body: JSON.stringify({ id: first.jobs[0].id, ok: true }) });
  assert.equal(env.DB.raw.prepare("SELECT status FROM jobs WHERE id = ?").get(first.jobs[0].id).status, "done");
});

test("inline search lists SoundCloud tracks and the chosen one replaces the placeholder", async () => {
  const sc = (u) => {
    if (u === "https://soundcloud.com/") return new Response('<script crossorigin src="https://a-v2.sndcdn.com/assets/app.js"></script>');
    if (u.startsWith("https://a-v2.sndcdn.com/")) return new Response('x={client_id:"abcdefghijklmnopqrstuvwxyz123456"}');
    if (u.startsWith("https://api-v2.soundcloud.com/search/tracks")) return Response.json({ collection: [
      { kind: "track", id: 5, title: "Song", user: { username: "Band" }, duration: 61000, policy: "ALLOW", media: { transcodings: [{ snipped: false }] } },
      { kind: "track", id: 6, title: "Preview only", user: { username: "Go" }, duration: 30000, policy: "SNIP", media: { transcodings: [{ snipped: true }] } },
    ] });
    if (u.startsWith("https://api-v2.soundcloud.com/tracks/5")) return Response.json({
      kind: "track", title: "Song", user: { username: "Band" }, duration: 61000, track_authorization: "t",
      artwork_url: "https://i1.sndcdn.com/artworks-abc-large.jpg",
      media: { transcodings: [{ url: "https://api-v2.soundcloud.com/media/5/mp3", preset: "mp3_1_0", snipped: false, format: { protocol: "progressive", mime_type: "audio/mpeg" } }] },
    });
    if (u.startsWith("https://api-v2.soundcloud.com/media/")) return Response.json({ url: "https://cf-media.example/5.mp3" });
    if (u === "https://cf-media.example/5.mp3") return new Response(new Uint8Array(2048));
    if (u === "https://i1.sndcdn.com/artworks-abc-t300x300.jpg") return new Response(new Uint8Array(4000), { headers: { "content-type": "image/jpeg" } });
  };
  const { calls, env } = setup(sc);
  // Telegram answers sendAudio with the uploaded file's id.
  const tgFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/sendAudio")) { await tgFetch(url, init); return Response.json({ ok: true, result: { message_id: 99, audio: { file_id: "FILE5" } } }); }
    return tgFetch(url, init);
  };
  await send(env, 111, "/start");
  const hook = (update) => {
    const waits = [];
    return worker.fetch(new Request("https://w/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify(update) }), env, { waitUntil: (p) => waits.push(p) }).then(() => Promise.all(waits));
  };

  await hook({ inline_query: { id: "q1", from: { id: 111 }, query: "song band" } });
  const answer = calls.find((c) => c.method === "answerInlineQuery");
  assert.equal(answer.body.results.length, 1, "the preview-only track is left out");
  assert.equal(answer.body.results[0].id, "5");
  assert.equal(answer.body.results[0].audio_url, "https://w/placeholder.mp3");
  assert.ok(answer.body.results[0].reply_markup, "a keyboard is needed for inline_message_id");

  await hook({ chosen_inline_result: { result_id: "5", from: { id: 111 }, query: "song band", inline_message_id: "IM1" } });
  const up = calls.find((c) => c.method === "sendAudio");
  assert.equal(up.body.chat_id, "111");
  assert.equal(up.body.audio, 2048);
  assert.equal(up.body.thumbnail, 4000, "cover art is attached at 300x300");
  assert.ok(calls.find((c) => c.method === "deleteMessage" && c.body.message_id === 99), "the helper upload is deleted");
  const edit = calls.find((c) => c.method === "editMessageMedia");
  assert.equal(edit.body.inline_message_id, "IM1");
  assert.equal(edit.body.media.media, "FILE5");

  // Second time round the track is already on Telegram: no placeholder, no download.
  await hook({ inline_query: { id: "q3", from: { id: 111 }, query: "song band" } });
  const again = calls.filter((c) => c.method === "answerInlineQuery").at(-1).body.results[0];
  assert.equal(again.audio_file_id, "FILE5");
  assert.equal(again.audio_url, undefined);
  const uploads = calls.filter((c) => c.method === "sendAudio").length;
  await hook({ chosen_inline_result: { result_id: "5", from: { id: 111 }, query: "song band", inline_message_id: "IM2" } });
  assert.equal(calls.filter((c) => c.method === "sendAudio").length, uploads, "a cached track isn't downloaded again");

  await hook({ inline_query: { id: "q2", from: { id: 222 }, query: "song" } });
  assert.equal(calls.filter((c) => c.method === "answerInlineQuery").at(-1).body.results.length, 0, "strangers get nothing");

  const ph = await worker.fetch(new Request("https://w/placeholder.mp3"), env, { waitUntil() {} });
  assert.equal(ph.headers.get("content-type"), "audio/mpeg");
});

test("wrong secrets are rejected", async () => {
  const { env } = setup();
  const hook = await worker.fetch(new Request("https://w/webhook", { method: "POST", body: "{}" }), env, { waitUntil() {} });
  assert.equal(hook.status, 403);
  const jobs = await worker.fetch(new Request("https://w/pc/jobs", { headers: { "X-PC-Key": "nope" } }), env, { waitUntil() {} });
  assert.equal(jobs.status, 403);
});
