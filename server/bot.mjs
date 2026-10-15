// Server version of the bot (Windows server, Node 22): same handlers as the Cloudflare Worker, but
// - it reads updates by long polling, so the server needs no public HTTPS address;
// - YouTube is downloaded right here with yt-dlp (server/ytdl.py), no PC needed;
// - inline search downloads the top SoundCloud results while you type and lists only tracks that are
//   ready, so picking one sends the real track straight away (no placeholder). Uploads go through a
//   priority queue (newest search first), search results are cached for a day, and every night the
//   searches you use most are re-run so their top tracks are ready before you ask (/warm does it now).
// Starting it removes the Worker's webhook; worker/connect.ps1 switches back to the Worker.
//
// Run: node server/bot.mjs   (BOT_TOKEN in .env next to this folder; see server/README section)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle, inlineSearch, inlineChosen, tg, say, upload, addArtwork, MAX_BYTES } from "../worker/index.js";
import { fetchSoundCloudById, searchSoundCloud } from "../worker/soundcloud.js";
import { fileStore } from "./store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || path.join(ROOT, ".venv", "Scripts", "python.exe");
const PLACEHOLDER_ORIGIN = "https://tiktok-bot.didigotreizoo.workers.dev"; // the Worker still serves /placeholder.mp3
const PREFETCH_COUNT = 3; // top results downloaded per search
const PREFETCH_BUDGET_MS = 6000; // the longest a search waits before answering
const ANSWER_WHEN_READY = 2; // answer once the best this many results are ready; the rest keep downloading
const TYPING_PAUSE_MS = 300; // Telegram sends a query per keystroke; only the last one in a pause is worked on
const UPLOAD_SLOTS = 2; // uploads to Telegram at once; more just queue up on Telegram's side
const SEARCH_TTL_S = 24 * 3600; // search results are reused for a day
const WARM_HOUR_UTC = 3; // nightly warm-up: re-run your most used searches and pre-load their top tracks
const WARM_QUERIES = 15;
const WARM_TRACKS_PER_QUERY = 6;

for (const line of fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.replace(/^﻿/, "").match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing from .env");
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
const env = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER: fileStore(path.join(ROOT, "data", "store.json")),
  LOCAL_DOWNLOAD: (msg, link) => youtube(msg, link),
  PREFETCH: (tracks, q) => prefetch(tracks, q),
  SEARCH: (query) => search(query),
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- inline prefetch ----------

const latestQuery = new Map(); // user id -> latest inline query id
const inflight = new Map(); // track id -> promise of its upload
let generation = 0; // bumped by every search; newer searches get their uploads first

// Upload queue: at most UPLOAD_SLOTS at once, newest search first, best-ranked track first within it.
// Tracks from a search you have already moved on from wait, and still get cached when there is room.
const waiting = new Map(); // track id -> { gen, rank, start }
let running = 0;
function pump() {
  while (running < UPLOAD_SLOTS && waiting.size) {
    const [id, next] = [...waiting].sort(([, a], [, b]) => b.gen - a.gen || a.rank - b.rank)[0];
    waiting.delete(id);
    running++;
    next.start(() => {
      running--;
      pump();
    });
  }
}
const uploadSlot = (id, gen, rank) => new Promise((start) => (waiting.set(id, { gen, rank, start }), pump()));
function bump(id, gen, rank) {
  const w = waiting.get(id);
  if (w && (gen > w.gen || (gen === w.gen && rank < w.rank))) Object.assign(w, { gen, rank });
}

function want(t, owner, gen, rank) {
  if (inflight.has(t.id)) bump(t.id, gen, rank);
  else inflight.set(t.id, cacheTrack(t.id, owner, gen, rank).finally(() => inflight.delete(t.id)));
  return inflight.get(t.id);
}

async function prefetch(tracks, q) {
  latestQuery.set(q.from.id, q.id);
  await sleep(TYPING_PAUSE_MS);
  if (latestQuery.get(q.from.id) !== q.id) return; // still typing; a newer query will do the work
  const gen = ++generation;
  const owner = await env.OWNER.get("owner");
  // One promise per top result, in ranked order; tracks already on Telegram count as done.
  const top = await Promise.all(
    tracks.slice(0, PREFETCH_COUNT).map(async (t, rank) =>
      (await env.OWNER.get(`fid:${t.id}`)) ? { cached: true, job: Promise.resolve() } : { cached: false, job: want(t, owner, gen, rank) },
    ),
  );
  // Answer once the best results are ready (or time is up), so a weaker track that happened to be
  // cached from an earlier search cannot stand in for them. The rest keep downloading for next time.
  const t0 = Date.now();
  await Promise.race([Promise.allSettled(top.slice(0, ANSWER_WHEN_READY).map((x) => x.job)), sleep(PREFETCH_BUDGET_MS)]);
  log(`inline "${q.query}": ${top.filter((x) => x.cached).length} cached, answered after ${Date.now() - t0} ms`);
}

// Telegram only lists audio it already has, so each track is uploaded once and its file_id is kept.
// Uploads go to a private storage channel (the bot is added there as an admin, see onMembership), or
// to the owner's chat until one is connected, and are deleted straight after either way.
async function cacheTrack(trackId, owner, gen, rank) {
  const storage = (await env.OWNER.get("storage_chat")) || owner;
  try {
    const t0 = Date.now();
    const t = await fetchSoundCloudById(trackId, env.OWNER);
    const t1 = Date.now();
    if (t.body.size > MAX_BYTES) return;
    const form = new FormData();
    form.append("chat_id", storage);
    form.append("disable_notification", "true");
    form.append("title", t.title.slice(0, 64));
    if (t.performer) form.append("performer", t.performer.slice(0, 64));
    if (t.duration) form.append("duration", String(t.duration));
    form.append("audio", new Blob([t.body], { type: t.mime }), `track.${t.ext}`);
    await addArtwork(form, t.artwork);
    const done = await uploadSlot(trackId, gen, rank);
    const t2 = Date.now();
    let sent;
    try {
      sent = await (await upload(env, "sendAudio", form)).json();
    } finally {
      done();
    }
    if (!sent.ok) return log("cache upload refused", trackId, sent.description);
    await env.OWNER.put(`fid:${trackId}`, sent.result.audio.file_id);
    log(`cached ${trackId}: download ${t1 - t0} ms, queue ${t2 - t1} ms, upload ${Date.now() - t2} ms, ${(t.body.size / 1048576).toFixed(1)} MB`);
    // The file stays on Telegram's servers after the message is gone, so the storage stays empty.
    tg(env, "deleteMessage", { chat_id: storage, message_id: sent.result.message_id }); // no need to wait
  } catch (e) {
    log("cache failed", trackId, e.message);
  }
}

// ---------- search cache and nightly warm-up ----------

const norm = (q) => q.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

async function search(query, fresh = false) {
  const key = `q:${norm(query)}`;
  if (!fresh) {
    const hit = await env.OWNER.get(key);
    if (hit) return JSON.parse(hit);
  }
  const tracks = await searchSoundCloud(query, env.OWNER, 8);
  await env.OWNER.put(key, JSON.stringify(tracks), { expirationTtl: SEARCH_TTL_S });
  return tracks;
}

// Searches you actually picked a track from, with how often: the night warm-up re-runs the top ones.
async function rememberQuery(query) {
  const q = norm(query || "");
  if (q.length < 2) return;
  const stats = JSON.parse((await env.OWNER.get("stats:queries")) || "{}");
  stats[q] = { n: (stats[q]?.n || 0) + 1, last: Date.now() };
  await env.OWNER.put("stats:queries", JSON.stringify(stats));
}

async function warm() {
  const owner = await env.OWNER.get("owner");
  if (!owner) return;
  const month = Date.now() - 30 * 24 * 3600 * 1000;
  const stats = JSON.parse((await env.OWNER.get("stats:queries")) || "{}");
  const top = Object.entries(stats).filter(([, v]) => v.last > month).sort(([, a], [, b]) => b.n - a.n).slice(0, WARM_QUERIES);
  let loaded = 0;
  for (const [q] of top) {
    const tracks = await search(q, true).catch(() => []);
    for (const [rank, t] of tracks.slice(0, WARM_TRACKS_PER_QUERY).entries()) {
      if (await env.OWNER.get(`fid:${t.id}`)) continue;
      await want(t, owner, -1, rank); // lowest priority: anything you search meanwhile goes first
      loaded++;
    }
  }
  log(`warm-up: ${top.length} searches, ${loaded} new tracks`);
  return { searches: top.length, loaded };
}

async function warmIfDue() {
  const today = new Date().toISOString().slice(0, 10);
  if (new Date().getUTCHours() !== WARM_HOUR_UTC || (await env.OWNER.get("warm:last")) === today) return;
  await env.OWNER.put("warm:last", today);
  await warm().catch((e) => log("warm-up failed", e.message));
}

// The bot added as an admin to a channel by the owner: that channel becomes the storage for inline tracks.
async function onMembership(m) {
  const owner = await env.OWNER.get("owner");
  if (m.chat.type !== "channel" || String(m.from?.id) !== owner) return;
  if (["administrator"].includes(m.new_chat_member?.status)) {
    await env.OWNER.put("storage_chat", String(m.chat.id));
    log("storage channel connected", m.chat.id);
    await say(env, owner, `Storage channel "${m.chat.title}" connected. Inline tracks are kept there now, not in this chat.`);
  } else if (String(m.chat.id) === (await env.OWNER.get("storage_chat"))) {
    await env.OWNER.delete("storage_chat");
    await say(env, owner, "Storage channel disconnected. Inline tracks go through this chat again.");
  }
}

// ---------- YouTube ----------

function runYtdl(url, folder) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, [path.join(ROOT, "server", "ytdl.py"), url, folder], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => log("ytdl:", String(d).trim().slice(0, 300)));
    p.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop()));
      } catch {
        resolve({ error: "Something went wrong on the server." });
      }
    });
  });
}

async function youtube(msg, link) {
  const chat = msg.chat.id;
  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_video" });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));
  try {
    const r = await runYtdl(link.url, folder);
    if (r.error) return say(env, chat, r.error);
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("reply_to_message_id", String(msg.message_id));
    const file = await fs.openAsBlob(r.path);
    if (r.mode === "audio") {
      await say(env, chat, "The video is too big for Telegram's 50 MB limit, so here's the audio.");
      form.append("title", r.title.slice(0, 64));
      if (r.uploader) form.append("performer", r.uploader.slice(0, 64));
      form.append("audio", file, path.basename(r.path));
      await upload(env, "sendAudio", form);
    } else {
      form.append("caption", r.title.slice(0, 900));
      form.append("supports_streaming", "true");
      for (const k of ["width", "height", "duration"]) if (r[k]) form.append(k, String(r[k]));
      form.append("video", file, path.basename(r.path));
      const res = await upload(env, "sendVideo", form);
      if (!res.ok) await say(env, chat, `Telegram refused the video (${res.status}).`);
    }
  } catch (e) {
    log("youtube failed", link.url, e.message);
    await say(env, chat, "Something went wrong on the server.");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

// ---------- long polling ----------

// "/warm" from the owner runs the night warm-up right away.
async function warmNow(msg) {
  if (String(msg.from?.id) !== (await env.OWNER.get("owner"))) return handle(msg, env);
  await say(env, msg.chat.id, "Warming up your usual searches...");
  const r = await warm();
  await say(env, msg.chat.id, `Done: ${r?.searches || 0} searches, ${r?.loaded || 0} new tracks ready.`);
}

async function main() {
  await tg(env, "deleteWebhook", {}); // updates come here now, not to the Worker
  log("bot started");
  setInterval(() => warmIfDue(), 10 * 60 * 1000);
  let offset = 0;
  for (;;) {
    try {
      const res = await (await tg(env, "getUpdates", { offset, timeout: 50, allowed_updates: ["message", "inline_query", "chosen_inline_result", "my_chat_member"] })).json();
      if (!res.ok) {
        log("getUpdates refused:", res.description);
        await sleep(5000);
        continue;
      }
      for (const u of res.result) {
        offset = u.update_id + 1;
        if (u.chosen_inline_result) rememberQuery(u.chosen_inline_result.query).catch(() => {});
        const job = u.message?.text === "/warm"
          ? warmNow(u.message)
          : u.message
          ? handle(u.message, env)
          : u.inline_query
            ? inlineSearch(u.inline_query, env, PLACEHOLDER_ORIGIN)
            : u.chosen_inline_result
              ? inlineChosen(u.chosen_inline_result, env)
              : u.my_chat_member
                ? onMembership(u.my_chat_member)
                : null;
        job?.catch((e) => log("handler failed", e.message)); // run in parallel, don't block polling
      }
    } catch (e) {
      log("polling error:", e.message);
      await sleep(3000);
    }
  }
}

main();
