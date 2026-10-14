"""Downloads one YouTube video (or Short) for the server bot and prints the result as JSON.

    python ytdl.py <url> <folder>

Picks the best H.264 + AAC that fits Telegram's 50 MB bot limit; if even the smallest video is too big,
falls back to audio only. Prints {"path", "mode": "video"|"audio", "title", ...} or {"error": "..."}.
"""
import json
import sys
from pathlib import Path

import imageio_ffmpeg
import yt_dlp

MAX_BYTES = 49 * 1024 * 1024


def size_of(fmt, duration):
    return fmt.get("filesize") or fmt.get("filesize_approx") or (fmt.get("tbr") or 0) * 1000 / 8 * duration


def pick(info):
    duration = info.get("duration") or 0
    formats = info.get("formats") or []
    audios = [f for f in formats if f.get("vcodec") == "none" and f.get("ext") == "m4a"]
    # Skip YouTube's "-drc" (dynamic range compressed) copies when the normal track is there.
    audio = max(audios, key=lambda f: ("drc" not in str(f.get("format_id")), f.get("abr") or 0), default=None)
    audio_size = size_of(audio, duration) if audio else 0
    videos = [f for f in formats if (f.get("vcodec") or "").startswith("avc1") and f.get("ext") == "mp4" and f.get("acodec") == "none"]
    for v in sorted(videos, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0), reverse=True):
        if (v.get("height") or 0) <= 1080 and size_of(v, duration) + audio_size < MAX_BYTES * 0.95:
            return (f"{v['format_id']}+{audio['format_id']}" if audio else v["format_id"]), "video"
    if audio and audio_size < MAX_BYTES:
        return audio["format_id"], "audio"
    return None, "too_big"


def main(url, folder):
    folder = Path(folder)
    base = {"quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe()}
    try:
        with yt_dlp.YoutubeDL(base) as ydl:
            info = ydl.extract_info(url, download=False)
        fmt, mode = pick(info)
        if mode == "too_big":
            return {"error": "That video is too long for Telegram's 50 MB limit for bots, even as audio only."}
        with yt_dlp.YoutubeDL({**base, "format": fmt, "outtmpl": str(folder / "%(id)s.%(ext)s"), "merge_output_format": "mp4"}) as ydl:
            ydl.download([url])
        path = next(p for p in folder.iterdir() if p.is_file())
        return {
            "path": str(path), "mode": mode, "title": (info.get("title") or "").strip(), "uploader": info.get("uploader") or "",
            "width": info.get("width") or 0, "height": info.get("height") or 0, "duration": int(info.get("duration") or 0),
        }
    except yt_dlp.utils.DownloadError as e:
        text = str(e).lower()
        if "sign in" in text or "age" in text:
            return {"error": "YouTube wants a sign-in for that video (age-restricted or bot check), so it can't be downloaded."}
        if "private" in text or "unavailable" in text or "removed" in text:
            return {"error": "That video is private, removed or not available."}
        return {"error": "Couldn't download that one. Try again in a minute."}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], sys.argv[2])))
