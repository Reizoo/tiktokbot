// Fetches a TikTok video page and returns the watermark-free MP4 (TikTok's own playback stream).
// The page sets cookies (tt_chain_token...) that the video CDN checks, so they are passed along.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export async function fetchTikTok(url) {
  const page = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9" }, redirect: "follow" });
  const html = await page.text();
  const cookie = page.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") || "";
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no video data on the page (HTTP ${page.status})`);
  const item = JSON.parse(m[1]).__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct;
  if (!item) throw new Error("not a video page, or the video is private or deleted");
  if (item.imagePost) throw new Error("photo post");
  const v = item.video || {};
  // Prefer the H.264 stream: it plays everywhere in Telegram. playAddr has no watermark; downloadAddr does.
  // Each stream lists several mirrors; the last one is often a www.tiktok.com page, not the file.
  const streams = [...(v.bitrateInfo || [])].sort((a, b) => /h264/i.test(b.CodecType) - /h264/i.test(a.CodecType));
  const urls = streams.flatMap((b) => b.PlayAddr?.UrlList || []).concat(v.playAddr || []);
  let video;
  for (const src of urls) {
    if (new URL(src).hostname === "www.tiktok.com") continue;
    const res = await fetch(src, { headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/", Cookie: cookie } });
    if (res.ok && (res.headers.get("content-type") || "").startsWith("video/")) { video = res; break; }
  }
  if (!video) throw new Error("no playable stream found");
  const author = item.author?.uniqueId ? `@${item.author.uniqueId}` : "";
  const caption = [author, (item.desc || "").trim()].filter(Boolean).join(" · ").slice(0, 900);
  return { body: await video.arrayBuffer(), caption, id: item.id };
}
