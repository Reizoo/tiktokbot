// Server version of the bot (Windows server, Node 22): same handlers as the Cloudflare Worker, but
// - it reads updates by long polling, so the server needs no public HTTPS address;
// - YouTube is downloaded right here with yt-dlp (server/ytdl.py), no PC needed;
// - inline search downloads the top SoundCloud results while you type and lists only tracks that are
//   ready, so picking one sends the real track straight away (no placeholder).
// Starting it removes the Worker's webhook; worker/connect.ps1 switches back to the Worker.
//
// Run: node server/bot.mjs   (BOT_TOKEN in .env next to this folder; see server/README section)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle, inlineSearch, inlineChosen, tg, say, upload, addArtwork, MAX_BYTES } from "../worker/index.js";
import { fetchSoundCloudById } from "../worker/soundcloud.js";
import { fileStore } from "./store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || path.join(ROOT, ".venv", "Scripts", "python.exe");
const PLACEHOLDER_ORIGIN = "https://tiktok-bot.didigotreizoo.workers.dev"; // the Worker still serves /placeholder.mp3
const PREFETCH_COUNT = 4; // top results downloaded per search
const PREFETCH_BUDGET_MS = 6000; // the longest a search waits before answering
const ANSWER_WHEN_READY = 2; // answer as soon as this many are ready; the rest keep downloading for next time
const TYPING_PAUSE_MS = 300; // Telegram sends a query per keystroke; only the last one in a pause is worked on

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
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- inline prefetch ----------

const latestQuery = new Map(); // user id -> latest inline query id
const inflight = new Map(); // track id -> promise of its upload

async function prefetch(tracks, q) {
  latestQuery.set(q.from.id, q.id);
  await sleep(TYPING_PAUSE_MS);
  if (latestQuery.get(q.from.id) !== q.id) return; // still typing; a newer query will do the work
  const owner = await env.OWNER.get("owner");
  const jobs = [];
  for (const t of tracks.slice(0, PREFETCH_COUNT)) {
    if (await env.OWNER.get(`fid:${t.id}`)) continue;
    if (!inflight.has(t.id)) inflight.set(t.id, cacheTrack(t.id, owner).finally(() => inflight.delete(t.id)));
    jobs.push(inflight.get(t.id));
  }
  // Answer once enough are ready (or all are done, or time's up). Whatever isn't ready keeps
  // downloading and will be instant on the next search.
  const cachedAlready = Math.min(tracks.length, PREFETCH_COUNT) - jobs.length;
  let done = 0;
  const enough = new Promise((resolve) => {
    if (cachedAlready >= ANSWER_WHEN_READY || !jobs.length) return resolve();
    for (const j of jobs) j.then(() => ++done + cachedAlready >= ANSWER_WHEN_READY && resolve());
  });
  const t0 = Date.now();
  await Promise.race([enough, Promise.allSettled(jobs), sleep(PREFETCH_BUDGET_MS)]);
  log(`inline "${q.query}": ${cachedAlready} cached, ${done} downloaded in ${Date.now() - t0} ms`);
}

// Telegram only lists audio it already has, so each track is uploaded once and its file_id is kept.
// Uploads go to a private storage channel (the bot is added there as an admin, see onMembership), or
// to the owner's chat until one is connected, and are deleted straight after either way.
async function cacheTrack(trackId, owner) {
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
    const sent = await (await upload(env, "sendAudio", form)).json();
    if (!sent.ok) return log("cache upload refused", trackId, sent.description);
    await env.OWNER.put(`fid:${trackId}`, sent.result.audio.file_id);
    log(`cached ${trackId}: download ${t1 - t0} ms, upload ${Date.now() - t1} ms, ${(t.body.size / 1048576).toFixed(1)} MB`);
    // The file stays on Telegram's servers after the message is gone, so the storage stays empty.
    tg(env, "deleteMessage", { chat_id: storage, message_id: sent.result.message_id }); // no need to wait
  } catch (e) {
    log("cache failed", trackId, e.message);
  }
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

async function main() {
  await tg(env, "deleteWebhook", {}); // updates come here now, not to the Worker
  log("bot started");
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
        const job = u.message
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
