"""PC half of the bot: downloads YouTube (videos and Shorts) and SoundCloud links with yt-dlp.

The Cloudflare Worker queues those links; this script asks it for jobs every few seconds, downloads them
and sends the file straight to the Telegram chat. Keep it running while you want YouTube/SoundCloud to work.

Needs BOT_TOKEN and PC_KEY in .env (written by worker/connect.ps1). Run: start-pc.bat
"""
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

import imageio_ffmpeg
import requests
import yt_dlp
from dotenv import load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")
WORKER = os.getenv("WORKER_URL", "https://tiktok-bot.didigotreizoo.workers.dev")
TOKEN = os.getenv("BOT_TOKEN", "")
PC_KEY = os.getenv("PC_KEY", "")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
MAX_BYTES = 49 * 1024 * 1024  # Telegram bots can upload up to 50 MB
POLL_SECONDS = 4

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pc-worker")


# ---------- Telegram ----------

def tg(method: str, **data):
    return requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data, timeout=60)


def tg_file(method: str, field: str, path: Path, **data):
    with open(path, "rb") as f:
        return requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data, files={field: (path.name, f)}, timeout=600)


# ---------- choosing a format that fits in 50 MB ----------

def size_of(fmt: dict, duration: float) -> float:
    if fmt.get("filesize"):
        return fmt["filesize"]
    if fmt.get("filesize_approx"):
        return fmt["filesize_approx"]
    return (fmt.get("tbr") or 0) * 1000 / 8 * duration


def pick_youtube_format(info: dict) -> tuple[str | None, str]:
    """Best H.264 video + AAC audio that fits under the Telegram limit; else audio only."""
    duration = info.get("duration") or 0
    formats = info.get("formats") or []
    audios = [f for f in formats if f.get("vcodec") == "none" and f.get("ext") == "m4a"]
    # Skip YouTube's "-drc" (dynamic range compressed) copies when the normal track is there.
    audio = max(audios, key=lambda f: ("drc" not in str(f.get("format_id")), f.get("abr") or 0), default=None)
    audio_size = size_of(audio, duration) if audio else 0
    videos = [f for f in formats if (f.get("vcodec") or "").startswith("avc1") and f.get("ext") == "mp4" and f.get("acodec") == "none"]
    for v in sorted(videos, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0), reverse=True):
        if (v.get("height") or 0) > 1080:
            continue
        if size_of(v, duration) + audio_size < MAX_BYTES * 0.95:
            return (f"{v['format_id']}+{audio['format_id']}" if audio else v["format_id"]), "video"
    # Single-file mp4 (video+audio together) as a fallback, e.g. format 18 (360p).
    combined = [f for f in formats if f.get("ext") == "mp4" and f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")]
    for f in sorted(combined, key=lambda f: f.get("height") or 0, reverse=True):
        if size_of(f, duration) < MAX_BYTES * 0.95:
            return f["format_id"], "video"
    if audio and audio_size < MAX_BYTES:
        return audio["format_id"], "audio"
    return None, "too_big"


# ---------- jobs ----------

def do_youtube(job: dict, folder: Path) -> None:
    chat, reply = job["chat_id"], job.get("reply_to")
    base = {"quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "ffmpeg_location": FFMPEG}
    with yt_dlp.YoutubeDL(base) as ydl:
        info = ydl.extract_info(job["url"], download=False)
    fmt, mode = pick_youtube_format(info)
    title = (info.get("title") or "").strip()
    if mode == "too_big":
        tg("sendMessage", chat_id=chat, text="That video is too long for Telegram's 50 MB limit for bots, even as audio only.")
        return
    opts = {**base, "format": fmt, "outtmpl": str(folder / "%(id)s.%(ext)s"), "merge_output_format": "mp4"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([job["url"]])
    path = next(p for p in folder.iterdir() if p.is_file())
    if mode == "audio":
        tg("sendMessage", chat_id=chat, text="The video is too big for Telegram's 50 MB limit, so here's the audio.")
        r = tg_file("sendAudio", "audio", path, chat_id=chat, title=title[:64], performer=info.get("uploader") or "", reply_to_message_id=reply or "")
    else:
        r = tg_file(
            "sendVideo", "video", path, chat_id=chat, caption=title[:900], supports_streaming="true",
            width=info.get("width") or "", height=info.get("height") or "", duration=int(info.get("duration") or 0),
            reply_to_message_id=reply or "",
        )
    if not r.ok:
        raise RuntimeError(f"Telegram refused the file: {r.status_code} {r.text[:200]}")


def do_soundcloud(job: dict, folder: Path) -> None:
    chat, reply = job["chat_id"], job.get("reply_to")
    opts = {
        "quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "ffmpeg_location": FFMPEG,
        "format": "bestaudio/best", "outtmpl": str(folder / "%(id)s.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(job["url"], download=True)
    path = next(p for p in folder.iterdir() if p.suffix == ".mp3")
    if path.stat().st_size > MAX_BYTES:
        tg("sendMessage", chat_id=chat, text="That track is over Telegram's 50 MB limit for bots.")
        return
    r = tg_file(
        "sendAudio", "audio", path, chat_id=chat, title=(info.get("title") or "")[:64],
        performer=info.get("uploader") or "", duration=int(info.get("duration") or 0), reply_to_message_id=reply or "",
    )
    if not r.ok:
        raise RuntimeError(f"Telegram refused the file: {r.status_code} {r.text[:200]}")


def run_job(job: dict) -> bool:
    folder = Path(tempfile.mkdtemp(prefix="dl-"))
    try:
        tg("sendChatAction", chat_id=job["chat_id"], action="upload_document")
        (do_soundcloud if job["kind"] == "soundcloud" else do_youtube)(job, folder)
        return True
    except yt_dlp.utils.DownloadError as e:
        log.warning("download failed %s: %s", job["url"], e)
        text = str(e).lower()
        if "drm" in text:
            reason = "That track is DRM-protected (SoundCloud Go+), so it can't be downloaded."
        elif "private" in text or "unavailable" in text or "removed" in text:
            reason = "That one is private, removed or not available."
        elif "sign in" in text or "age" in text:
            reason = "YouTube wants a sign-in for that video (age-restricted or bot check), so it can't be downloaded."
        else:
            reason = "Couldn't download that one. Try again in a minute, or update yt-dlp if it keeps failing."
        tg("sendMessage", chat_id=job["chat_id"], text=reason)
        return False
    except Exception:
        log.exception("job %s failed", job.get("id"))
        tg("sendMessage", chat_id=job["chat_id"], text="Something went wrong on the PC. Check the pc_worker window.")
        return False
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def main() -> None:
    if not TOKEN or not PC_KEY:
        raise SystemExit("BOT_TOKEN or PC_KEY is missing from .env: run worker/connect.ps1 first (see README).")
    headers = {"X-PC-Key": PC_KEY}
    log.info("pc worker started, polling %s", WORKER)
    while True:
        try:
            jobs = requests.get(f"{WORKER}/pc/jobs", headers=headers, timeout=20).json().get("jobs", [])
            for job in jobs:
                log.info("job %s: %s %s", job["id"], job["kind"], job["url"])
                ok = run_job(job)
                requests.post(f"{WORKER}/pc/done", headers=headers, json={"id": job["id"], "ok": ok}, timeout=20)
        except requests.RequestException as e:
            log.warning("worker unreachable: %s", e)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
