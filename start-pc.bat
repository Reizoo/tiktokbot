@echo off
rem PC half of the bot: downloads YouTube and SoundCloud links queued by the Cloudflare Worker.
cd /d "%~dp0"
".venv\Scripts\python.exe" pc_worker.py
pause
