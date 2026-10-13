# TikTok bot

A private Telegram bot: send it a TikTok link and it sends the video back without the watermark.

Two versions:
- **`worker/` (main): runs on Cloudflare Workers**, free, works with the PC off. Reads TikTok's page itself, no yt-dlp.
- **`bot.py`: runs on this PC** with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [aiogram](https://aiogram.dev). A backup if TikTok ever changes its page and the Worker breaks.

## Cloudflare version (once)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`. Copy the token.
2. On this PC, right-click `worker/connect.ps1` → *Run with PowerShell*. It sends the token from the clipboard to Cloudflare, connects Telegram to the Worker, and clears the clipboard.
3. Open your bot in Telegram and send `/start`. The first person to do this becomes the owner; nobody else can use it.

Worker: https://tiktok-bot.didigotreizoo.workers.dev (Telegram posts to `/webhook`, checked with a secret header). Tests: `cd worker && npm test`. Deploy: `npx wrangler deploy`.

## PC version setup (once)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`.
2. Copy the token BotFather gives you.
3. On this PC, right-click `save-token.ps1` → *Run with PowerShell*. It saves the token to `.env` straight from the clipboard.
4. Double-click `start.bat`. Keep the window open while you want the bot to work.
5. Open your bot in Telegram and send `/start`. The first person to do this becomes the owner; nobody else can use it.

First-time install of the libraries (already done on this PC):

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Notes

- Picks TikTok's clean H.264 stream (no watermark), not the watermarked "download" file.
- Telegram lets bots send files up to 50 MB; longer videos above that get a message instead.
- Photo slideshows aren't supported yet.
- If downloads start failing, update yt-dlp: `.venv\Scripts\python -m pip install -U "yt-dlp[default,curl-cffi]"`.
- For personal use. Respect creators' rights when reposting.
