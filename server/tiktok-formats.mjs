// TikTok on the server: the bot asks which format you want (MP4 / GIF / MP3) and builds it with ffmpeg.
//
// Why ffmpeg: TikTok's H.264 streams carry very low quality sound (HE-AAC at about 32 kb/s), which is
// what made the videos sound bad. The post's own sound (music.playUrl) is AAC at about 128 kb/s, and
// the 1080p H.265 stream has 64 kb/s. So the MP4 keeps the H.264 picture (plays everywhere in Telegram)
// and swaps in the best sound available. GIF and MP3 are made from the same files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { tg, say, upload, MAX_BYTES } from "../worker/index.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const GIF_MAX_SECONDS = 20; // longer GIFs get huge; the first 20 seconds are kept
const LINK_TTL_S = 24 * 3600; // a format button keeps working for a day

export function tiktokFormats(env, { ffmpeg, log }) {
  // ---------- reading the post ----------

  async function readPost(url) {
    const page = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9" }, redirect: "follow" });
    const html = await page.text();
    const cookie = page.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") || "";
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`no post data on the page (HTTP ${page.status})`);
    const scope = JSON.parse(m[1]).__DEFAULT_SCOPE__ || {};
    const item = Object.entries(scope).find(([k, v]) => /detail/.test(k) && v?.itemInfo?.itemStruct)?.[1].itemInfo.itemStruct;
    if (!item) throw new Error("not a post page, or the post is private or deleted");
    const get = async (src) => {
      const res = await fetch(src, { headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/", Cookie: cookie } });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    };
    const author = item.author?.uniqueId ? `@${item.author.uniqueId}` : "";
    return { item, get, author, caption: [author, (item.desc || "").trim()].filter(Boolean).join(" · ").slice(0, 900) };
  }

  // First working mirror of a stream (the last mirror is often a www.tiktok.com page, not the file).
  async function firstFile(get, urls) {
    for (const src of urls) {
      if (new URL(src).hostname === "www.tiktok.com") continue;
      const buf = await get(src);
      if (buf && buf.length > 1000) return buf;
    }
    return null;
  }

  // Best H.264 picture that fits Telegram's limit, plus the best sound we can get.
  async function videoAndSound(post) {
    const v = post.item.video || {};
    const streams = [...(v.bitrateInfo || [])];
    const h264 = streams.filter((b) => /h264/i.test(b.CodecType)).sort((a, b) => b.Bitrate - a.Bitrate);
    let video = null;
    for (const b of h264) {
      if (b.PlayAddr?.DataSize && b.PlayAddr.DataSize > MAX_BYTES * 0.9) continue;
      video = await firstFile(post.get, b.PlayAddr?.UrlList || []);
      if (video) break;
    }
    if (!video && v.playAddr) video = await firstFile(post.get, [v.playAddr]);
    if (!video) throw new Error("no playable stream found");

    // Sound: the post's own sound when it is the video's original audio (same length), else the 1080p stream's.
    const music = post.item.music || {};
    const sameLength = music.duration && v.duration && Math.abs(music.duration - v.duration) <= 1;
    let sound = null;
    if (music.playUrl && music.original && sameLength) sound = await post.get(music.playUrl);
    if (!sound) {
      const best = streams.filter((b) => !/h264/i.test(b.CodecType)).sort((a, b) => b.Bitrate - a.Bitrate)[0];
      if (best) sound = await firstFile(post.get, best.PlayAddr?.UrlList || []);
    }
    return { video, sound, duration: v.duration || 0, width: v.width || 0, height: v.height || 0 };
  }

  function run(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 300) || `ffmpeg exit ${code}`))));
    });
  }

  // ---------- building each format ----------

  async function makeMp4(dir, parts) {
    const v = path.join(dir, "v.mp4");
    fs.writeFileSync(v, parts.video);
    if (!parts.sound) return v;
    const a = path.join(dir, "a.m4a");
    fs.writeFileSync(a, parts.sound);
    const out = path.join(dir, "tiktok.mp4");
    try {
      await run(["-i", v, "-i", a, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", "-movflags", "+faststart", out]);
      return out;
    } catch (e) {
      log("tiktok remux failed, sending the original", e.message);
      return v;
    }
  }

  async function makeMp3(dir, parts) {
    const src = path.join(dir, "src.bin");
    fs.writeFileSync(src, parts.sound || parts.video);
    const out = path.join(dir, "sound.mp3");
    await run(["-i", src, "-vn", "-c:a", "libmp3lame", "-q:a", "2", out]);
    return out;
  }

  async function makeGif(dir, parts) {
    const v = path.join(dir, "v.mp4");
    fs.writeFileSync(v, parts.video);
    const out = path.join(dir, "tiktok.gif");
    // Two-pass palette keeps the colours decent; smaller sizes if the first try is over the limit.
    for (const [width, fps] of [[360, 12], [300, 10], [240, 8]]) {
      const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
      await run(["-t", String(GIF_MAX_SECONDS), "-i", v, "-filter_complex", filter, out]);
      if (fs.statSync(out).size < MAX_BYTES * 0.95) return out;
    }
    throw new Error("the GIF is over Telegram's 50 MB limit");
  }

  // ---------- Telegram side ----------

  // A TikTok link: ask which format, remembering the link under a short key for the buttons.
  async function ask(msg, url) {
    const key = Math.random().toString(36).slice(2, 10);
    await env.OWNER.put(`tt:${key}`, JSON.stringify({ url, reply: msg.message_id }), { expirationTtl: LINK_TTL_S });
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Which format?",
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: [[
        { text: "🎬 MP4", callback_data: `tt:mp4:${key}` },
        { text: "🎞 GIF", callback_data: `tt:gif:${key}` },
        { text: "🎵 MP3", callback_data: `tt:mp3:${key}` },
      ]] },
    });
  }

  async function onButton(cq) {
    const [, fmt, key] = cq.data.split(":");
    const chat = cq.message.chat.id;
    const saved = JSON.parse((await env.OWNER.get(`tt:${key}`)) || "null");
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: saved ? "On it…" : "That button has expired, send the link again." });
    if (!saved) return;
    await tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, text: `Making the ${fmt.toUpperCase()}…` });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
    try {
      await send(chat, saved, fmt, dir);
      await tg(env, "deleteMessage", { chat_id: chat, message_id: cq.message.message_id });
    } catch (e) {
      log("tiktok", fmt, "failed", saved.url, e.message);
      await tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, text: `Couldn't make the ${fmt.toUpperCase()}: ${e.message}. Try again in a minute.` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function send(chat, saved, fmt, dir) {
    const post = await readPost(saved.url);
    const base = () => {
      const form = new FormData();
      form.append("chat_id", String(chat));
      form.append("reply_to_message_id", String(saved.reply));
      return form;
    };
    if (post.item.imagePost?.images?.length) {
      // Photo slideshows have no video: MP3 sends the sound, the other buttons point you at it.
      if (fmt !== "mp3" || !post.item.music?.playUrl) throw new Error("that post is a photo slideshow, so only MP3 works for it");
      const sound = await post.get(post.item.music.playUrl);
      const file = await makeMp3(dir, { sound });
      return sendMp3(base(), file, post);
    }
    const parts = await videoAndSound(post);
    if (fmt === "mp3") return sendMp3(base(), await makeMp3(dir, parts), post);
    if (fmt === "gif") {
      const file = await makeGif(dir, parts);
      const form = base();
      form.append("disable_content_type_detection", "true");
      form.append("document", await fs.openAsBlob(file), "tiktok.gif");
      if (post.caption) form.append("caption", post.caption);
      return check(await upload(env, "sendDocument", form));
    }
    const file = await makeMp4(dir, parts);
    if (fs.statSync(file).size > MAX_BYTES) throw new Error("the video is over Telegram's 50 MB limit");
    const form = base();
    if (post.caption) form.append("caption", post.caption);
    form.append("supports_streaming", "true");
    for (const k of ["width", "height", "duration"]) if (parts[k]) form.append(k, String(parts[k]));
    form.append("video", await fs.openAsBlob(file), "tiktok.mp4");
    return check(await upload(env, "sendVideo", form));
  }

  async function sendMp3(form, file, post) {
    const m = post.item.music || {};
    const title = (m.original ? (post.item.desc || "").trim() : m.title) || m.title || "TikTok sound";
    form.append("title", title.slice(0, 64));
    form.append("performer", ((m.original ? post.author : m.authorName) || post.author || "").slice(0, 64));
    const name = title.replace(/[\\/:*?"<>|#]+/g, "").trim().slice(0, 60) || "tiktok";
    form.append("audio", await fs.openAsBlob(file), `${name}.mp3`);
    return check(await upload(env, "sendAudio", form));
  }

  async function check(res) {
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram refused it (${res.status} ${body.slice(0, 120)})`);
  }

  // For a local check without Telegram: builds the file and returns its path.
  async function buildOnly(url, fmt, dir) {
    const post = await readPost(url);
    const parts = await videoAndSound(post);
    return fmt === "mp3" ? makeMp3(dir, parts) : fmt === "gif" ? makeGif(dir, parts) : makeMp4(dir, parts);
  }

  return { ask, onButton, buildOnly };
}
