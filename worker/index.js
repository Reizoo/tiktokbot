// Private Telegram bot on Cloudflare Workers.
// - TikTok videos and photo slideshows: downloaded here and sent back straight away.
// - YouTube (videos and Shorts) and SoundCloud: queued in D1; the PC (pc_worker.py, with yt-dlp) picks them up.
// Telegram calls POST /webhook (set up by connect.ps1). Only the owner (first /start) can use the bot.
// The PC calls GET /pc/jobs and POST /pc/done with the X-PC-Key header.
import { fetchTikTok } from "./tiktok.js";
import { findLink } from "./links.js";

const MAX_BYTES = 49 * 1024 * 1024; // Telegram bots can upload up to 50 MB
const PC_ONLINE_MS = 30_000; // the PC polls every few seconds; quieter than this means it's off

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/pc/")) return pcApi(request, env, url);
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("ok");
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await request.json().catch(() => null);
    // Answer Telegram straight away; the download carries on in the background.
    if (update?.message) ctx.waitUntil(handle(update.message, env));
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
    return say(env, chat, "Send me a link and I'll send the file back:\n• TikTok videos (no watermark) and photo slideshows\n• YouTube videos and Shorts\n• SoundCloud tracks\n\nYouTube and SoundCloud are downloaded on the PC, so they only work while it's on.");
  }
  if (!owner || String(from) !== owner) return say(env, chat, "This is a private bot.");

  const link = findLink(text);
  if (!link) return say(env, chat, "Send a TikTok, YouTube or SoundCloud link.");
  if (link.kind === "tiktok") return sendTikTok(env, msg, link.url);
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
