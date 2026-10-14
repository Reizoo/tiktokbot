// Re-sorts SoundCloud search results: SoundCloud's own order lets re-uploads, speed-ups and remixes
// crowd out the actual song, especially when the query has both artist and title ("толер кишлак").
const VARIANTS = ["speed", "sped", "spedup", "speedup", "slowed", "reverb", "remix", "nightcore", "cover", "8d", "bass", "boosted",
  "mashup", "edit", "instrumental", "karaoke", "acoustic", "live", "beat", "typebeat", "ремикс", "кавер", "минус", "замедленная", "ускоренная"];

export const tokens = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean);

// A track only counts if it has a full stream that isn't DRM-encrypted (those can't be downloaded).
export const downloadable = (t) =>
  (t.media?.transcodings || []).some((x) => !x.snipped && !/encrypted/i.test(x.format?.protocol || ""));

export function rankTracks(query, tracks) {
  const q = tokens(query);
  const qset = new Set(q);
  return tracks
    .map((t, i) => {
      const text = new Set(tokens(`${t.title} ${t.user?.username || ""} ${t.publisher_metadata?.artist || ""}`));
      const titleWords = new Set(tokens(t.title));
      const matched = q.filter((w) => text.has(w) || [...text].some((x) => x.startsWith(w) && w.length > 2)).length;
      const variant = VARIANTS.some((v) => titleWords.has(v) && !qset.has(v));
      const artist = tokens(`${t.publisher_metadata?.artist || ""} ${t.user?.username || ""}`);
      const official = (t.user?.verified || t.publisher_metadata?.artist) && q.some((w) => artist.includes(w));
      const score =
        (q.length ? matched / q.length : 0) * 3 + // every word of the query found in title or artist
        Math.log10((t.playback_count || 0) + 1) / 7 - // popularity, 0..~1
        (variant ? 1.5 : 0) + // speed up / remix / ... that you didn't ask for
        (official ? 0.4 : 0) - // the artist's own upload
        i * 0.01; // SoundCloud's order breaks ties
      return { t, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}
