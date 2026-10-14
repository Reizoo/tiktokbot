// SoundCloud through its own web API (the one soundcloud.com uses), no yt-dlp or ffmpeg.
// Order of preference: a single MP3 file, an MP3 HLS stream (segments joined), an AAC HLS stream
// (fMP4 init + segments joined into an .m4a). Telegram's sendAudio takes both MP3 and M4A.
// DRM-protected (Go+) streams are skipped: they can't be decrypted and we don't try.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Origin: "https://soundcloud.com", Referer: "https://soundcloud.com/" };

// The public web client id sits in one of soundcloud.com's script bundles; it changes now and then.
async function clientId(kv, fresh = false) {
  if (!fresh) {
    const cached = await kv?.get("sc_client_id");
    if (cached) return cached;
  }
  const home = await (await fetch("https://soundcloud.com/", { headers: HEADERS })).text();
  const scripts = [...home.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const src of scripts) {
    const m = (await (await fetch(src, { headers: HEADERS })).text()).match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/);
    if (m) {
      await kv?.put("sc_client_id", m[1], { expirationTtl: 24 * 3600 });
      return m[1];
    }
  }
  throw new Error("couldn't find SoundCloud's client id");
}

async function resolve(url, kv) {
  for (const fresh of [false, true]) {
    const id = await clientId(kv, fresh);
    const res = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${id}`, { headers: HEADERS });
    if (res.ok) return { track: await res.json(), id };
    if (res.status === 404) throw new Error("track not found, private or deleted");
  }
  throw new Error("SoundCloud refused the request");
}

async function joinHls(m3u8Url) {
  const list = await (await fetch(m3u8Url, { headers: HEADERS })).text();
  if (/#EXT-X-KEY:(?!METHOD=NONE)/.test(list)) throw new Error("encrypted stream");
  const base = new URL(m3u8Url);
  const parts = [];
  const init = list.match(/#EXT-X-MAP:URI="([^"]+)"/);
  if (init) parts.push(new URL(init[1], base).href);
  for (const line of list.split("\n")) if (line && !line.startsWith("#")) parts.push(new URL(line.trim(), base).href);
  // Fetch segments 6 at a time (Cloudflare's limit for open connections), keeping their order.
  const chunks = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      const r = await fetch(parts[i], { headers: HEADERS });
      if (!r.ok) throw new Error(`segment failed (HTTP ${r.status})`);
      chunks[i] = new Uint8Array(await r.arrayBuffer());
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, parts.length) }, worker));
  return new Blob(chunks);
}

export async function fetchSoundCloud(url, kv) {
  const { track, id } = await resolve(url, kv);
  if (track.kind !== "track") throw new Error("not a single track (playlists aren't supported)");
  return downloadTrack(track, id);
}

// For inline mode: the result id is the track id.
export async function fetchSoundCloudById(trackId, kv) {
  for (const fresh of [false, true]) {
    const id = await clientId(kv, fresh);
    const res = await fetch(`https://api-v2.soundcloud.com/tracks/${encodeURIComponent(trackId)}?client_id=${id}`, { headers: HEADERS });
    if (res.ok) return downloadTrack(await res.json(), id);
    if (res.status === 404) throw new Error("track not found, private or deleted");
  }
  throw new Error("SoundCloud refused the request");
}

// Search for inline mode. Only tracks with a full (not preview-only) stream come back.
export async function searchSoundCloud(query, kv, limit = 8) {
  for (const fresh of [false, true]) {
    const id = await clientId(kv, fresh);
    const res = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=${limit * 2}&client_id=${id}`, { headers: HEADERS });
    if (!res.ok) continue;
    const { collection = [] } = await res.json();
    return collection
      .filter((t) => t.kind === "track" && t.policy !== "SNIP" && t.policy !== "BLOCK" && (t.media?.transcodings || []).some((x) => !x.snipped))
      .slice(0, limit)
      .map((t) => ({ id: String(t.id), title: t.title || "Untitled", performer: t.user?.username || "", duration: Math.round((t.duration || 0) / 1000) }));
  }
  throw new Error("SoundCloud search failed");
}

// Cover art at 300x300 (Telegram wants audio thumbnails at most 320px and under 200 kB).
// Tracks without their own artwork fall back to the uploader's picture, like SoundCloud does.
function artworkUrl(track) {
  const src = track.artwork_url || track.user?.avatar_url || "";
  return src ? src.replace(/-(large|t\d+x\d+|crop|original)\.(jpg|png)/, "-t300x300.jpg") : null;
}

async function downloadTrack(track, id) {
  const options = (track.media?.transcodings || []).filter((t) => !t.snipped && !/encrypted|ctr|cbc/i.test(t.format?.protocol || ""));
  const rank = (t) =>
    t.format.protocol === "progressive" && /mpeg/.test(t.format.mime_type) ? 0
      : t.format.protocol === "hls" && /mpeg/.test(t.format.mime_type) ? 1
      : t.format.protocol === "hls" && /mp4/.test(t.format.mime_type) ? 2
      : 9;
  for (const t of options.sort((a, b) => rank(a) - rank(b)).filter((t) => rank(t) < 9)) {
    const res = await fetch(`${t.url}?client_id=${id}&track_authorization=${track.track_authorization}`, { headers: HEADERS });
    if (!res.ok) continue; // some listed streams answer 404; try the next one
    const { url: media } = await res.json();
    try {
      const body = t.format.protocol === "progressive" ? await (await fetch(media, { headers: HEADERS })).blob() : await joinHls(media);
      const mp3 = /mpeg/.test(t.format.mime_type);
      return {
        body,
        artwork: artworkUrl(track),
        ext: mp3 ? "mp3" : "m4a",
        mime: mp3 ? "audio/mpeg" : "audio/mp4",
        title: track.title || "SoundCloud track",
        performer: track.user?.username || "",
        duration: Math.round((track.duration || 0) / 1000),
      };
    } catch (e) {
      console.log("soundcloud stream failed", t.preset, e.message);
    }
  }
  throw new Error(track.policy === "SNIP" ? "only a 30-second preview is available (Go+ track)" : "no downloadable stream (DRM-protected or blocked)");
}
