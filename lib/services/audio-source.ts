import axios from 'axios';
import { logger } from '../utils/logger';

export interface AudioResult {
  buffer: Buffer;
  title: string;
  artist: string;
  durationSeconds?: number;
}

export class AudioSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioSourceError';
  }
}

// ── Configuration ────────────────────────────────────────────────────────────
const PROVIDER_TIMEOUT_MS = 5_000;
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://invidious.nerdvpn.de',
];

// ── In-memory cache ──────────────────────────────────────────────────────────
const audioCache = new Map<string, { result: AudioResult; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheGet(key: string): AudioResult | null {
  const e = audioCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { audioCache.delete(key); return null; }
  return e.result;
}

function cacheSet(key: string, result: AudioResult): void {
  audioCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear audio cache (exported for testing). */
export function clearAudioCache(): void {
  audioCache.clear();
}

function normalizeCacheKey(artist: string, title: string): string {
  return `${artist} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanSearchQuery(track: string, artist: string): string {
  const cleanTrack = track.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  const cleanArtist = artist.split(',')[0].split(' feat')[0].split(' ft')[0].split(' &')[0].trim();
  return `${cleanTrack} ${cleanArtist}`.trim();
}

function buildQueryVariants(track: string, artist: string): string[] {
  const cleanTrack = track.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanArtist = artist.split(',')[0].split(' feat')[0].split(' ft')[0].split(' &')[0].trim();
  const variants: string[] = [];
  const v1 = `${cleanTrack} ${cleanArtist}`.trim();
  if (v1) variants.push(v1);
  const titleOnly = cleanTrack.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  const v2 = `${titleOnly} ${cleanArtist}`.trim();
  if (v2 && v2 !== v1 && v2) variants.push(v2);
  if (titleOnly && titleOnly !== v1 && titleOnly !== v2) variants.push(titleOnly);
  return variants;
}

function findBestMatch(results: unknown[], track: string, artist: string): unknown | null {
  const lowerTrack = track.toLowerCase();
  const lowerArtist = artist.split(',')[0].trim().toLowerCase();
  const scored = results.map((r: any) => {
    const rTitle = (r.title || r.name || r.song || '').toLowerCase();
    const rArtist = (r.artists?.primary?.map((a: any) => a.name).join(', ') || r.primaryArtists || r.singers || r.artist || (rTitle.includes(' - ') ? rTitle.split(' - ')[0] : '')).toLowerCase().trim();
    let score = 0;
    if (rTitle === lowerTrack) score += 10;
    else if (rTitle.includes(lowerTrack) || lowerTrack.includes(rTitle)) score += 7;
    else { const tw = lowerTrack.split(/\s+/); const rw = rTitle.split(/\s+/); score += tw.filter((w: string) => rw.some((x: string) => x.includes(w) || w.includes(x))).length * 2; }
    if (rArtist && lowerArtist && (rArtist.includes(lowerArtist) || lowerArtist.includes(rArtist.split(',')[0].trim()))) score += 5;
    return { result: r, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 2 ? scored[0].result : scored[0]?.result || null;
}

function extractDownloadUrl(match: any): string | undefined {
  const links = match.downloadUrl || match.download_url;
  if (Array.isArray(links) && links.length > 0) { const best = links[links.length - 1]; return best.url || best.link || best; }
  return undefined;
}

function extractMetadata(match: any, fallbackTrack: string, fallbackArtist: string) {
  const title = match.name || match.title || match.song || fallbackTrack;
  let artist: string;
  if (match.artists?.primary) artist = match.artists.primary.map((a: any) => a.name).join(', ');
  else artist = match.primaryArtists || match.singers || match.artist || fallbackArtist;
  return { title, artist, durationSeconds: match.duration ? parseInt(match.duration, 10) : undefined };
}

async function downloadAudioBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer', timeout: PROVIDER_TIMEOUT_MS, signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const buffer = Buffer.from(response.data);
  if (!buffer || buffer.length === 0) throw new AudioSourceError('Downloaded audio file is empty.');
  const head = buffer.subarray(0, 100).toString('utf-8').trim().toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) throw new AudioSourceError('Audio source returned HTML instead of audio data.');
  return buffer;
}

// ── Provider 1: Invidious (YouTube) — instances run in parallel ──────────────

interface InvidiousVideo { videoId: string; title: string; author: string; lengthSeconds: number; type: string; }

async function tryInvidiousInstance(instance: string, query: string, track: string, artist: string, signal?: AbortSignal): Promise<AudioResult | null> {
  const searchUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`;
  const searchResponse = await axios.get<InvidiousVideo[]>(searchUrl, { timeout: PROVIDER_TIMEOUT_MS, signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const videos = searchResponse.data;
  if (!videos || !Array.isArray(videos) || videos.length === 0) return null;
  const match = findBestMatch(videos, track, artist) as InvidiousVideo | null;
  if (!match) return null;
  const infoUrl = `${instance}/api/v1/videos/${match.videoId}?fields=title,author,lengthSeconds,adaptiveFormats`;
  const infoResponse = await axios.get(infoUrl, { timeout: PROVIDER_TIMEOUT_MS, signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const videoInfo = infoResponse.data;
  const audioFormats = (videoInfo.adaptiveFormats || []).filter((f: any) => f.type?.startsWith('audio/') && f.url);
  if (audioFormats.length === 0) return null;
  const fmt = audioFormats.find((f: any) => f.type?.includes('opus')) || audioFormats.find((f: any) => f.type?.includes('mp4a')) || audioFormats[audioFormats.length - 1];
  const buffer = await downloadAudioBuffer(fmt.url, signal);
  return { buffer, title: videoInfo.title || track, artist: videoInfo.author || artist, durationSeconds: videoInfo.lengthSeconds || undefined };
}

async function tryInvidiousParallel(query: string, track: string, artist: string, signal?: AbortSignal): Promise<AudioResult | null> {
  // Run all instances in parallel — first valid result wins
  const promises = INVIDIOUS_INSTANCES.map(instance =>
    tryInvidiousInstance(instance, query, track, artist, signal).catch(() => null)
  );
  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}

// ── Provider 2: saavn.dev ────────────────────────────────────────────────────

async function trySaavnDev(query: string, track: string, artist: string, signal?: AbortSignal): Promise<AudioResult | null> {
  const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=5`;
  const searchResponse = await axios.get(searchUrl, { timeout: PROVIDER_TIMEOUT_MS, signal });
  const results = searchResponse.data?.data?.results;
  if (!results || !Array.isArray(results) || results.length === 0) return null;
  const match = findBestMatch(results, track, artist);
  if (!match) return null;
  const downloadUrl = extractDownloadUrl(match);
  if (!downloadUrl) return null;
  const buffer = await downloadAudioBuffer(downloadUrl, signal);
  const metadata = extractMetadata(match, track, artist);
  return { buffer, title: metadata.title, artist: metadata.artist, durationSeconds: metadata.durationSeconds };
}

// ── Provider 3: JioSaavn direct ──────────────────────────────────────────────

async function tryJioSaavnDirect(query: string, track: string, artist: string, signal?: AbortSignal): Promise<AudioResult | null> {
  const searchResponse = await axios.get('https://www.jiosaavn.com/api.php', {
    params: { __call: 'search.getResults', _format: 'json', _marker: 0, api_version: 4, ctx: 'web6dot0', query, n: 5, p: 1 },
    timeout: PROVIDER_TIMEOUT_MS, signal, headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const results = searchResponse.data?.results;
  if (!results || !Array.isArray(results) || results.length === 0) return null;
  const match = findBestMatch(results, track, artist);
  if (!match) return null;
  const downloadUrl = extractDownloadUrl(match);
  if (!downloadUrl) return null;
  const buffer = await downloadAudioBuffer(downloadUrl, signal);
  const metadata = extractMetadata(match, track, artist);
  return { buffer, title: metadata.title, artist: metadata.artist, durationSeconds: metadata.durationSeconds };
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Finds and downloads audio. All providers run in PARALLEL.
 * First valid result wins via Promise.any. Max 5s per provider.
 */
export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const startTime = Date.now();
  const query = cleanSearchQuery(track, artist);
  const cacheKey = normalizeCacheKey(artist, track);

  // Cache check
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[PERF] Audio search START artist="${artist}" track="${track}" cache=HIT`);
    console.log(`[PERF] Audio search TOTAL duration=${Date.now() - startTime}ms result=FOUND provider=cache`);
    return cached;
  }

  console.log(`[PERF] Audio search START artist="${artist}" track="${track}" query="${query}"`);

  const variants = buildQueryVariants(track, artist);

  for (let vi = 0; vi < variants.length; vi++) {
    const q = variants[vi];
    console.log(`[PERF] Audio search variant ${vi + 1}/${variants.length} query="${q}"`);

    // Single AbortController for this variant — all providers share it
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const signal = controller.signal;

    // Fire all providers in PARALLEL
    console.log(`[PERF] Provider START name="invidious" query="${q}"`);
    console.log(`[PERF] Provider START name="saavn" query="${q}"`);
    console.log(`[PERF] Provider START name="jiosaavn" query="${q}"`);

    const providerPromises = [
      tryInvidiousParallel(q, track, artist, signal)
        .then(r => { if (r) console.log(`[PERF] Provider END name="invidious" duration=${Date.now() - startTime}ms result=FOUND`); return r; })
        .catch(() => { console.log(`[PERF] Provider END name="invidious" duration=${Date.now() - startTime}ms result=ERROR`); return null; }),
      trySaavnDev(q, track, artist, signal)
        .then(r => { if (r) console.log(`[PERF] Provider END name="saavn" duration=${Date.now() - startTime}ms result=FOUND`); return r; })
        .catch(() => { console.log(`[PERF] Provider END name="saavn" duration=${Date.now() - startTime}ms result=ERROR`); return null; }),
      tryJioSaavnDirect(q, track, artist, signal)
        .then(r => { if (r) console.log(`[PERF] Provider END name="jiosaavn" duration=${Date.now() - startTime}ms result=FOUND`); return r; })
        .catch(() => { console.log(`[PERF] Provider END name="jiosaavn" duration=${Date.now() - startTime}ms result=ERROR`); return null; }),
    ];

    // Wrap each to reject on null so Promise.any skips non-results
    const racePromises = providerPromises.map(p =>
      p.then(r => r ?? Promise.reject(new Error('not found')))
    );

    try {
      const result = await Promise.any(racePromises);
      clearTimeout(timer);
      console.log(`[PERF] Audio search FIRST_RESULT duration=${Date.now() - startTime}ms`);
      console.log(`[PERF] Audio search TOTAL duration=${Date.now() - startTime}ms result=FOUND`);
      cacheSet(cacheKey, result);
      return result;
    } catch {
      clearTimeout(timer);
      console.log(`[PERF] Audio search variant ${vi + 1} all providers failed`);
    }
  }

  console.log(`[PERF] Audio search FAILED reason="all providers exhausted" variants=${variants.length} totalMs=${Date.now() - startTime}`);
  throw new AudioSourceError(`No audio results found for "${query}".`);
}
