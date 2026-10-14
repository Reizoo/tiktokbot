// Private Telegram bot on Cloudflare Workers.
// - TikTok videos and photo slideshows: downloaded here and sent back straight away.
// - SoundCloud: downloaded here too (MP3 when SoundCloud has it, otherwise M4A); falls back to the PC queue.
// - YouTube (videos and Shorts): queued in D1; the PC (pc_worker.py, with yt-dlp) picks them up.
// - Inline mode: "@bot track name" in any chat searches SoundCloud; the picked result goes out as a
//   placeholder and is swapped for the real track once downloaded (see inlineChosen).
// Telegram calls POST /webhook (set up by connect.ps1). Only the owner (first /start) can use the bot.
// The PC calls GET /pc/jobs and POST /pc/done with the X-PC-Key header.
import { fetchTikTok } from "./tiktok.js";
import { findLink } from "./links.js";
import { fetchSoundCloud, fetchSoundCloudById, searchSoundCloud } from "./soundcloud.js";
import { SILENCE_MP3 } from "./placeholder.js";

const MAX_BYTES = 49 * 1024 * 1024; // Telegram bots can upload up to 50 MB
const PC_ONLINE_MS = 30_000; // the PC polls every few seconds; quieter than this means it's off

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/pc/")) return pcApi(request, env, url);
    if (url.pathname === "/placeholder.mp3") return new Response(SILENCE_MP3, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("ok");
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    // Answer Telegram straight away; the download carries on in the background.
    if (update?.message) ctx.waitUntil(handle(update.message, env));
    if (update?.inline_query) ctx.waitUntil(inlineSearch(update.inline_query, env, url.origin));
    if (update?.chosen_inline_result) ctx.waitUntil(inlineChosen(update.chosen_inline_result, env));
    return new Response("ok");
  },
};

async function handle(msg, env) {
  const chat = msg.chat.id;
  const from = msg.from?.id;
  const text = msg.text || msg.caption || "";
  let owner = await env.OWNER.get("owner");

  if (text.startsWith("/start")) {
    if (!owner) {
      owner = String(from);
      await env.OWNER.put("owner", owner);
    }
    if (String(from) !== owner) return say(env, chat, "This is a private bot.");
    await refreshSetup(env, chat);
    return say(env, chat, "Send me a link and I'll send the file back:\n• TikTok videos (no watermark) and photo slideshows\n• YouTube videos and Shorts\n• SoundCloud tracks\n\nYouTube and SoundCloud are downloaded on the PC, so they only work while it's on.");
  }
  if (!owner || String(from) !== owner) return say(env, chat, "This is a private bot.");

  const link = findLink(text);
  if (!link) return say(env, chat, "Send a TikTok, YouTube or SoundCloud link.");
  if (link.kind === "tiktok") return sendTikTok(env, msg, link.url);
  if (link.kind === "soundcloud") return sendSoundCloud(env, msg, link);
  return queueForPc(env, msg, link);
}

async function sendTikTok(env, msg, url) {
  const chat = msg.chat.id;
  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_video" });
  try {
    const post = await fetchTikTok(url);
    if (post.type === "photos") return sendSlideshow(env, msg, post);
    if (post.body.byteLength > MAX_BYTES) return say(env, chat, "The video is over 50 MB, which is Telegram's limit for bots.");
    const form = new FormData();
    form.append("chat_id", String(chat));
    if (post.caption) form.append("caption", post.caption);
    form.append("supports_streaming", "true");
    form.append("reply_to_message_id", String(msg.message_id));
    form.append("video", new Blob([post.body], { type: "video/mp4" }), "tiktok.mp4");
    const res = await upload(env, "sendVideo", form);
    if (!res.ok) throw new Error(`Telegram refused the video (HTTP ${res.status})`);
  } catch (e) {
    console.log("tiktok failed", url, e.message);
    await say(env, chat, "Couldn't download that one. The post may be private or deleted, or TikTok blocked the request. Try again in a minute.");
  }
}

async function sendSoundCloud(env, msg, link) {
  const chat = msg.chat.id;
  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_voice" });
  try {
    const t = await fetchSoundCloud(link.url, env.OWNER);
    if (t.body.size > MAX_BYTES) return say(env, chat, "That track is over Telegram's 50 MB limit for bots.");
    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("title", t.title.slice(0, 64));
    if (t.performer) form.append("performer", t.performer.slice(0, 64));
    if (t.duration) form.append("duration", String(t.duration));
    form.append("reply_to_message_id", String(msg.message_id));
    const name = `${t.performer ? t.performer + " - " : ""}${t.title}`.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "track";
    form.append("audio", new Blob([t.body], { type: t.mime }), `${name}.${t.ext}`);
    const res = await upload(env, "sendAudio", form);
    if (!res.ok) throw new Error(`Telegram refused the audio (HTTP ${res.status})`);
  } catch (e) {
    console.log("soundcloud failed", link.url, e.message);
    if (/preview|DRM|private|deleted|playlists/.test(e.message)) return say(env, chat, `Couldn't download that one: ${e.message}.`);
    return queueForPc(env, msg, link); // let yt-dlp on the PC have a go
  }
}

// Photos go out as albums of up to 10 (Telegram's limit), then the sound as an audio file.
async function sendSlideshow(env, msg, post) {
  const chat = msg.chat.id;
  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_photo" });
  for (let start = 0; start < post.images.length; start += 10) {
    const batch = post.images.slice(start, start + 10);
    const form = new FormData();
    form.append("chat_id", String(chat));
    const media = [];
    for (const [i, src] of batch.entries()) {
      const res = await post.get(src);
      if (!res.ok) continue;
      const name = `p${i}`;
      form.append(name, new Blob([await res.arrayBuffer()], { type: res.headers.get("content-type") || "image/jpeg" }), `${name}.jpg`);
      media.push({ type: "photo", media: `attach://${name}`, ...(start === 0 && i === 0 && post.caption ? { caption: post.caption } : {}) });
    }
    if (!media.length) continue;
    form.append("media", JSON.stringify(media));
    const res = await upload(env, "sendMediaGroup", form);
    if (!res.ok) console.log("sendMediaGroup failed", res.status, (await res.text()).slice(0, 200));
  }
  if (post.music) {
    const res = await post.get(post.music.url);
    if (res.ok) {
      const form = new FormData();
      form.append("chat_id", String(chat));
      form.append("title", post.music.title);
      if (post.music.performer) form.append("performer", post.music.performer);
      form.append("audio", new Blob([await res.arrayBuffer()], { type: "audio/mpeg" }), "sound.mp3");
      await upload(env, "sendAudio", form);
    }
  }
}

async function queueForPc(env, msg, link) {
  const chat = msg.chat.id;
  await env.DB.prepare("INSERT INTO jobs (chat_id, reply_to, url, kind, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(chat, msg.message_id, link.url, link.kind, Date.now())
    .run();
  const seen = Number((await env.DB.prepare("SELECT value FROM meta WHERE key = 'pc_seen'").first())?.value || 0);
  const online = Date.now() - seen < PC_ONLINE_MS;
  await say(env, chat, online ? "Downloading on the PC…" : "The PC is off. I'll send it as soon as it's back on.");
}

// /start from the owner re-registers the webhook with every update type the bot uses (an older
// connect.ps1 only asked for messages) and checks that inline mode is switched on in @BotFather.
async function refreshSetup(env, chat) {
  const hook = await (await tg(env, "getWebhookInfo", {})).json();
  const wanted = ["message", "inline_query", "chosen_inline_result"];
  const have = hook.result?.allowed_updates || ["message"];
  if (hook.result?.url && wanted.some((u) => !have.includes(u))) {
    await tg(env, "setWebhook", { url: hook.result.url, secret_token: env.WEBHOOK_SECRET, allowed_updates: wanted });
  }
  const me = await (await tg(env, "getMe", {})).json();
  if (!me.result?.supports_inline_queries) {
    await say(env, chat, "Inline search is off. In @BotFather send /setinline, pick this bot and type a hint like \"track name\". Then /setinlinefeedback, pick the bot and choose Enabled. After that, send /start here again.");
  }
}

// ---------- inline mode ----------

// The 🔍 button under each sent track opens a new search in the same chat, like other music bots.
const SEARCH_AGAIN = { inline_keyboard: [[{ text: "🔍", switch_inline_query_current_chat: "" }]] };

async function inlineSearch(q, env, origin) {
  const owner = await env.OWNER.get("owner");
  const answer = (results, extra = {}) => tg(env, "answerInlineQuery", { inline_query_id: q.id, results, cache_time: 300, is_personal: true, ...extra });
  if (!owner || String(q.from.id) !== owner) return answer([], { cache_time: 3600 });
  const query = q.query.trim();
  if (query.length < 2) return answer([]);
  try {
    const tracks = await searchSoundCloud(query, env.OWNER, 8);
    // Tracks sent before are already on Telegram's servers: those go out straight away, no placeholder.
    const cached = await Promise.all(tracks.map((t) => env.OWNER.get(`fid:${t.id}`)));
    return answer(
      tracks.map((t, i) =>
        cached[i]
          ? { type: "audio", id: t.id, audio_file_id: cached[i], reply_markup: SEARCH_AGAIN }
          : {
              type: "audio",
              id: t.id,
              audio_url: `${origin}/placeholder.mp3`,
              title: t.title.slice(0, 64),
              performer: t.performer.slice(0, 64),
              audio_duration: t.duration,
              caption: "⏳",
              reply_markup: SEARCH_AGAIN, // needed: without a keyboard Telegram doesn't send back inline_message_id
            },
      ),
    );
  } catch (e) {
    console.log("inline search failed", e.message);
    return answer([]);
  }
}

// Telegram can't take a fresh upload into an inline message, so the track goes to the owner's own chat
// first (silently, deleted straight after) to get a file_id, and the placeholder is then edited into it.
// The file_id is kept in KV (fid:<track id>), so the same track is sent instantly next time.
// Needs inline feedback switched on in @BotFather (/setinlinefeedback).
async function inlineChosen(r, env) {
  const owner = await env.OWNER.get("owner");
  if (!owner || String(r.from.id) !== owner || !r.inline_message_id) return;
  if (await env.OWNER.get(`fid:${r.result_id}`)) return; // sent from cache, nothing to swap
  try {
    const t = await fetchSoundCloudById(r.result_id, env.OWNER);
    if (t.body.size > MAX_BYTES) throw new Error("over 50 MB");
    const form = new FormData();
    form.append("chat_id", owner);
    form.append("disable_notification", "true");
    form.append("title", t.title.slice(0, 64));
    if (t.performer) form.append("performer", t.performer.slice(0, 64));
    if (t.duration) form.append("duration", String(t.duration));
    form.append("audio", new Blob([t.body], { type: t.mime }), `track.${t.ext}`);
    const sent = await (await upload(env, "sendAudio", form)).json();
    if (!sent.ok) throw new Error(`upload refused: ${sent.description}`);
    await env.OWNER.put(`fid:${r.result_id}`, sent.result.audio.file_id);
    await tg(env, "deleteMessage", { chat_id: owner, message_id: sent.result.message_id });
    const res = await (await tg(env, "editMessageMedia", {
      inline_message_id: r.inline_message_id,
      media: { type: "audio", media: sent.result.audio.file_id, title: t.title.slice(0, 64), performer: t.performer.slice(0, 64), duration: t.duration },
      reply_markup: SEARCH_AGAIN,
    })).json();
    if (!res.ok) throw new Error(`edit refused: ${res.description}`);
  } catch (e) {
    console.log("inline download failed", r.result_id, e.message);
    await tg(env, "editMessageCaption", { inline_message_id: r.inline_message_id, caption: "Couldn't download this track.", reply_markup: SEARCH_AGAIN });
  }
}

// ---------- PC side: pc_worker.py ----------

async function pcApi(request, env, url) {
  if (!env.PC_KEY || request.headers.get("X-PC-Key") !== env.PC_KEY) return new Response("forbidden", { status: 403 });
  const now = Date.now();
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('pc_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(now))
    .run();

  if (url.pathname === "/pc/jobs" && request.method === "GET") {
    // Jobs claimed over 15 minutes ago by a PC that then crashed go back to the queue.
    await env.DB.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'claimed' AND claimed_at < ?").bind(now - 15 * 60_000).run();
    const { results } = await env.DB.prepare(
      "UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 3) RETURNING id, chat_id, reply_to, url, kind",
    )
      .bind(now)
      .all();
    return Response.json({ jobs: results || [] });
  }
  if (url.pathname === "/pc/done" && request.method === "POST") {
    const { id, ok } = await request.json();
    await env.DB.prepare("UPDATE jobs SET status = ? WHERE id = ?").bind(ok ? "done" : "failed", id).run();
    return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

// ---------- Telegram ----------

function say(env, chat, text) {
  return tg(env, "sendMessage", { chat_id: chat, text });
}

function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function upload(env, method, form) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", body: form });
}
