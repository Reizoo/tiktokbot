"""Private Telegram bot: send it a TikTok link, it sends the video back without the watermark.

Only one person can use it: whoever sends /start first becomes the owner (saved in owner.json),
or set OWNER_ID in .env. Everyone else gets a short "private bot" reply.

Run: .venv/Scripts/python bot.py   (BOT_TOKEN must be in .env, see README)
"""
import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

import yt_dlp
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import FSInputFile, Message
from dotenv import load_dotenv

HERE = Path(__file__).parent
OWNER_FILE = HERE / "owner.json"
TIKTOK_URL = re.compile(r"https?://(?:[\w-]+\.)?tiktok\.com/\S+", re.I)
MAX_BYTES = 49 * 1024 * 1024  # Telegram bots can upload up to 50 MB

# TikTok offers one "download" format with the watermark and several clean ones (the ones the app plays).
# Prefer clean h264 (plays everywhere in Telegram), smallest-first fallbacks keep it under 50 MB.
FORMAT = (
    "b[format_id!=download][vcodec^=h264][filesize<49M]"
    "/b[format_id!=download][vcodec^=h264]"
    "/b[format_id!=download][filesize<49M]"
    "/b[format_id!=download]"
)

load_dotenv(HERE / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tiktok-bot")


def owner_id() -> int | None:
    if os.getenv("OWNER_ID"):
        return int(os.environ["OWNER_ID"])
    if OWNER_FILE.exists():
        return json.loads(OWNER_FILE.read_text())["id"]
    return None


def download(url: str, folder: Path) -> tuple[Path, str]:
    """Download one TikTok video into folder. Returns (file, caption)."""
    opts = {
        "format": FORMAT,
        "outtmpl": str(folder / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = [p for p in folder.iterdir() if p.is_file()]
    if not files:
        raise RuntimeError("nothing was downloaded")
    author = info.get("uploader") or info.get("creator") or ""
    title = (info.get("title") or info.get("description") or "").strip()
    caption = (f"@{author} · " if author else "") + title
    return files[0], caption[:900]


dp = Dispatcher()


@dp.message(CommandStart())
async def start(message: Message) -> None:
    current = owner_id()
    if current is None:
        OWNER_FILE.write_text(json.dumps({"id": message.from_user.id}))
        current = message.from_user.id
        log.info("owner set to %s", current)
    if message.from_user.id != current:
        await message.answer("This is a private bot.")
        return
    await message.answer("Send me a TikTok link and I'll send the video back without the watermark.")


@dp.message(F.text)
async def on_text(message: Message) -> None:
    if message.from_user.id != owner_id():
        await message.answer("This is a private bot.")
        return
    match = TIKTOK_URL.search(message.text)
    if not match:
        await message.answer("Send a TikTok link (tiktok.com, vm.tiktok.com or vt.tiktok.com).")
        return

    status = await message.answer("Downloading…")
    folder = Path(tempfile.mkdtemp(prefix="tt-"))
    try:
        path, caption = await asyncio.to_thread(download, match.group(0), folder)
        if path.stat().st_size > MAX_BYTES:
            await status.edit_text("The video is over 50 MB, which is Telegram's limit for bots.")
            return
        await message.answer_video(FSInputFile(path), caption=caption or None, supports_streaming=True)
        await status.delete()
    except yt_dlp.utils.DownloadError as e:
        log.warning("download failed for %s: %s", match.group(0), e)
        text = str(e)
        if "photo" in text.lower() or "slideshow" in text.lower():
            await status.edit_text("That looks like a photo post. Only videos are supported for now.")
        else:
            await status.edit_text("Couldn't download that one. The video may be private or deleted, or TikTok blocked the request. Try again in a minute.")
    except Exception:
        log.exception("unexpected error")
        await status.edit_text("Something went wrong. Check the bot window for the error.")
    finally:
        shutil.rmtree(folder, ignore_errors=True)


async def main() -> None:
    token = os.getenv("BOT_TOKEN")
    if not token:
        raise SystemExit("BOT_TOKEN is missing: run save-token.ps1 first (see README).")
    bot = Bot(token)
    log.info("bot started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
