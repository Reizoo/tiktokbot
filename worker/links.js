// Which service a link belongs to. TikTok runs in the Worker; YouTube and SoundCloud go to the PC (yt-dlp).
const PATTERNS = [
  ["tiktok", /https?:\/\/(?:[\w-]+\.)?tiktok\.com\/\S+/i],
  ["youtube", /https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?\S*v=|shorts\/|live\/)|youtu\.be\/)\S+/i],
  ["soundcloud", /https?:\/\/(?:(?:www|m|on)\.)?soundcloud\.(?:com|app\.goo\.gl)\/\S+/i],
];

export function findLink(text) {
  for (const [kind, re] of PATTERNS) {
    const m = String(text || "").match(re);
    if (m) return { kind, url: m[0] };
  }
  return null;
}
