# Downloader bot

A private Telegram bot: send it a link and it sends the file back.

| Link | What comes back | Runs on |
|---|---|---|
| TikTok video | MP4 without the watermark | Cloudflare Worker, always on |
| TikTok photo slideshow | the photos as albums of up to 10, plus the sound as MP3 | Cloudflare Worker, always on |
| YouTube video or Short | MP4 (best quality that fits in 50 MB; audio only if even 360p is too big) | this PC, while `start-pc.bat` is running |
| SoundCloud track | MP3 when SoundCloud has one, otherwise M4A (same audio, no re-encoding), with title and artist | Cloudflare Worker, always on (falls back to the PC) |

YouTube blocks downloads from data centres, so YouTube goes through the PC. The Worker queues those links in D1 (and SoundCloud links it couldn't fetch itself), and `pc_worker.py` (yt-dlp + ffmpeg) picks them up every few seconds and sends the file straight to the chat. If the PC is off, the bot says so and sends the file once it's back.

## Setup (once)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`. Copy the token.
2. Right-click `worker/connect.ps1` → *Run with PowerShell*. It sends the token from the clipboard to Cloudflare, writes `.env` for the PC part, connects Telegram to the Worker, and clears the clipboard.
3. Open your bot in Telegram and send `/start`. The first person to do this becomes the owner; nobody else can use it.
4. For YouTube, double-click `start-pc.bat` and leave the window open.

Python libraries for the PC part (already installed here):

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## How it fits together

- `worker/index.js`: Telegram webhook (`/webhook`, checked with a secret header), owner lock in KV, TikTok handling, the job queue, and `/pc/jobs` + `/pc/done` for the PC (checked with `X-PC-Key`).
- `worker/tiktok.js`: reads TikTok's page and picks the clean H.264 stream, or the images and sound of a slideshow.
- `worker/links.js`: decides which service a link belongs to.
- `worker/soundcloud.js`: SoundCloud through its web API; joins HLS segments into one MP3 or M4A file.
- `worker/schema.sql`: the D1 tables (`jobs`, `meta`).
- `pc_worker.py`: polls the Worker, downloads with yt-dlp, uploads to Telegram.

Tests: `cd worker && npm test` (fake Telegram, SQLite in place of D1, real TikTok). Deploy: `cd worker && npx wrangler deploy`.

## Notes

- Telegram lets bots upload up to 50 MB, so long YouTube videos come down in lower quality or as audio.
- Many SoundCloud tracks only have an AAC stream now, so they come as M4A; turning that into MP3 would need ffmpeg, which a Worker can't run. Telegram plays M4A the same way.
- DRM-protected SoundCloud tracks (Go+) and age-restricted YouTube videos can't be downloaded.
- If YouTube starts failing, update yt-dlp: `.venv\Scripts\python -m pip install -U "yt-dlp[default,curl-cffi]"`.
- For personal use. Respect creators' rights when reposting.
