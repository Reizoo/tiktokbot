// Private Telegram bot on Cloudflare Workers: send it a TikTok link, get the video back without the watermark.
// Telegram calls POST /webhook (set up by connect.ps1). Only the owner (first /start) can use it.
import { fetchTikTok } from "./tiktok.js";

const TIKTOK_URL = /https?:\/\/(?:[\w-]+\.)?tiktok\.com\/\S+/i;
const MAX_BYTES = 49 * 1024 * 1024; // Telegram bots can upload up to 50 MB

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
  const text = msg.text || "";
  let owner = await env.OWNER.get("owner");

  if (text.startsWith("/start")) {
    if (!owner) {
      owner = String(from);
      await env.OWNER.put("owner", owner);
    }
    if (String(from) !== owner) return tg(env, "sendMessage", { chat_id: chat, text: "This is a private bot." });
    return tg(env, "sendMessage", { chat_id: chat, text: "Send me a TikTok link and I'll send the video back without the watermark." });
  }
  if (!owner || String(from) !== owner) return tg(env, "sendMessage", { chat_id: chat, text: "This is a private bot." });

  const link = text.match(TIKTOK_URL)?.[0];
  if (!link) return tg(env, "sendMessage", { chat_id: chat, text: "Send a TikTok link (tiktok.com, vm.tiktok.com or vt.tiktok.com)." });

  await tg(env, "sendChatAction", { chat_id: chat, action: "upload_video" });
  try {
    const { body, caption } = await fetchTikTok(link);
    if (body.byteLength > MAX_BYTES) {
      return tg(env, "sendMessage", { chat_id: chat, text: "The video is over 50 MB, which is Telegram's limit for bots." });
    }
    const form = new FormData();
    form.append("chat_id", String(chat));
    if (caption) form.append("caption", caption);
    form.append("supports_streaming", "true");
    form.append("reply_to_message_id", String(msg.message_id));
    form.append("video", new Blob([body], { type: "video/mp4" }), "tiktok.mp4");
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Telegram refused the video (HTTP ${res.status})`);
  } catch (e) {
    console.log("download failed", link, e.message);
    const reason = /photo post/.test(e.message)
      ? "That looks like a photo post. Only videos are supported for now."
      : "Couldn't download that one. The video may be private or deleted, or TikTok blocked the request. Try again in a minute.";
    await tg(env, "sendMessage", { chat_id: chat, text: reason });
  }
}

function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
