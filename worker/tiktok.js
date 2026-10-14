// Reads a TikTok post page and returns either the watermark-free MP4 (TikTok's own playback stream)
// or, for photo slideshows, the image URLs and the sound.
// The page sets cookies (tt_chain_token...) that the media CDN checks, so they are passed along.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export async function fetchTikTok(url) {
  const page = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9" }, redirect: "follow" });
  const html = await page.text();
  const cookie = page.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") || "";
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no post data on the page (HTTP ${page.status})`);
  const scope = JSON.parse(m[1]).__DEFAULT_SCOPE__ || {};
  // Videos live under "webapp.video-detail"; take any *-detail entry so /photo/ pages work too.
  const item = Object.entries(scope).find(([k, v]) => /detail/.test(k) && v?.itemInfo?.itemStruct)?.[1].itemInfo.itemStruct;
  if (!item) throw new Error("not a post page, or the post is private or deleted");

  const author = item.author?.uniqueId ? `@${item.author.uniqueId}` : "";
  const caption = [author, (item.desc || "").trim()].filter(Boolean).join(" · ").slice(0, 900);
  const get = (src) => fetch(src, { headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/", Cookie: cookie } });

  if (item.imagePost?.images?.length) {
    const images = item.imagePost.images
      .map((img) => {
        const list = img.imageURL?.urlList || img.displayImage?.urlList || [];
        return list.find((u) => /jpe?g/i.test(u)) || list[0];
      })
      .filter(Boolean);
    const music = item.music?.playUrl ? { url: item.music.playUrl, title: item.music.title || "TikTok sound", performer: item.music.authorName || "" } : null;
    return { type: "photos", images, music, caption, get };
  }

  const v = item.video || {};
  // Prefer the H.264 stream: it plays everywhere in Telegram. playAddr has no watermark; downloadAddr does.
  // Each stream lists several mirrors; the last one is often a www.tiktok.com page, not the file.
  const streams = [...(v.bitrateInfo || [])].sort((a, b) => /h264/i.test(b.CodecType) - /h264/i.test(a.CodecType));
  const urls = streams.flatMap((b) => b.PlayAddr?.UrlList || []).concat(v.playAddr || []);
  for (const src of urls) {
    if (new URL(src).hostname === "www.tiktok.com") continue;
    const res = await get(src);
    if (res.ok && (res.headers.get("content-type") || "").startsWith("video/")) {
      return { type: "video", body: await res.arrayBuffer(), caption, id: item.id };
    }
  }
  throw new Error("no playable stream found");
}
