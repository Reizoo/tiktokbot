-- Jobs the PC downloads with yt-dlp (YouTube, Shorts, SoundCloud). TikTok is handled in the Worker itself.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  reply_to INTEGER,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,            -- youtube | soundcloud
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done | failed
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);
-- Last time the PC asked for jobs, so the bot can say whether the PC is on.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
