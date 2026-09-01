import axios from 'axios';
import { logger } from '../utils/logger';

export interface AudioResult {
  buffer: Buffer;
  title: string;
  artist: string;
  durationSeconds?: number;
  spotifyUrl?: string;
}

export class AudioSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioSourceError';
  }
}

/** Error thrown when audio providers fail but Spotify found the track. */
export class SpotifyFallbackError extends AudioSourceError {
  constructor(
    message: string,
    public spotifyUrl: string,
    public spotifyTitle: string,
    public spotifyArtist: string,
  ) {
    super(message);
    this.name = 'SpotifyFallbackError';
  }
}

// ── Configuration ────────────────────────────────────────────────────────────
const PROVIDER_TIMEOUT_MS = 5_000;
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://invidious.nerdvpn.de',
];

// ── Caches ───────────────────────────────────────────────────────────────────
const audioCache = new Map<string, { result: AudioResult; expiresAt: number }>();
const AUDIO_CACHE_TTL_MS = 30 * 60 * 1000;

const spotifyCache = new Map<string, { result: SpotifyMeta | null; expiresAt: number }>();
const SPOTIFY_CACHE_TTL_MS = 60 * 60 * 1000;

interface SpotifyMeta { spotifyUrl: string; title: string; artist: string; }

function audioCacheGet(key: string): AudioResult | null {
  const e = audioCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { audioCache.delete(key); return null; }
  return e.result;
}

function audioCacheSet(key: string, result: AudioResult): void {
  audioCache.set(key, { result, expiresAt: Date.now() + AUDIO_CACHE_TTL_MS });
}

/** Clear audio cache (exported for testing). */
export function clearAudioCache(): void {
  audioCache.clear();
  spotifyCache.clear();
}

function spotifyCacheGet(key: string): SpotifyMeta | null {
  const e = spotifyCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { spotifyCache.delete(key); return null; }
  return e.result;
}

function spotifyCacheSet(key: string, result: SpotifyMeta | null): void {
  spotifyCache.set(key, { result, expiresAt: Date.now() + SPOTIFY_CACHE_TTL_MS });
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
  if (v2 && v2 !== v1) variants.push(v2);
  if (titleOnly && titleOnly !== v1 && titleOnly !== v2) variants.push(titleOnly);
  return variants;
}

/** Normalize string for matching: lowercase, strip punctuation, remove noise words. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/[-–—_]/g, ' ')
    .replace(/[''`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(official|audio|lyrics|video|remix|slowed|sped up|prod\.?|prod by)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(spTitle: string, acTitle: string): boolean {
  const nsp = normalizeForMatch(spTitle);
  const nac = normalizeForMatch(acTitle);
  if (!nsp || !nac) return false;
  return nsp.includes(nac) || nac.includes(nsp) || nsp === nac;
}

function artistMatches(spArtist: string, acArtist: string): boolean {
  const nsp = normalizeForMatch(spArtist);
  const nac = normalizeForMatch(acArtist);
  if (!nsp || !nac) return false;
  return nsp.includes(nac) || nac.includes(nsp);
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

// ── Provider 1: Invidious (YouTube) — instances parallel ─────────────────────

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
  const promises = INVIDIOUS_INSTANCES.map(inst => tryInvidiousInstance(inst, query, track, artist, signal).catch(() => null));
  const results = await Promise.allSettled(promises);
  for (const r of results) { if (r.status === 'fulfilled' && r.value) return r.value; }
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

// ── Provider 4: Spotify metadata (NOT audio source) ─────────────────────────

let spotifyToken: string | null = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken(): Promise<string | null> {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` }, timeout: PROVIDER_TIMEOUT_MS },
    );
    spotifyToken = response.data.access_token;
    spotifyTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch {
    return null;
  }
}

async function trySpotifyMetadata(query: string, track: string, artist: string, signal?: AbortSignal): Promise<SpotifyMeta | null> {
  const cacheKey = `spotify:${normalizeCacheKey(artist, track)}`;
  const cached = spotifyCacheGet(cacheKey);
  if (cached !== null) {
    console.log(`[PERF] Spotify metadata CACHE ${cached ? 'HIT' : 'MISS'}`);
    return cached;
  }

  const token = await getSpotifyToken();
  if (!token) { spotifyCacheSet(cacheKey, null); return null; }

  try {
    console.log(`[PERF] Spotify search START query="${query}"`);
    const response = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: PROVIDER_TIMEOUT_MS, signal,
    });

    const tracks = response.data?.tracks?.items;
    if (!tracks || tracks.length === 0) {
      console.log(`[PERF] Spotify search END result=NOT_FOUND`);
      spotifyCacheSet(cacheKey, null);
      return null;
    }

    for (const sp of tracks) {
      const spTitle = sp.name || '';
      const spArtist = (sp.artists || []).map((a: any) => a.name).join(', ');
      if (titleMatches(spTitle, track) && artistMatches(spArtist, artist)) {
        const result: SpotifyMeta = {
          spotifyUrl: sp.external_urls?.spotify || '',
          title: spTitle,
          artist: spArtist,
        };
        console.log(`[PERF] Spotify search END result=FOUND title="${spTitle}" artist="${spArtist}"`);
        console.log(`[PERF] Spotify metadata normalized artist="${spArtist}" title="${spTitle}"`);
        spotifyCacheSet(cacheKey, result);
        return result;
      }
    }

    console.log(`[PERF] Spotify search END result=NOT_FOUND (no match)`);
    spotifyCacheSet(cacheKey, null);
    return null;
  } catch {
    console.log(`[PERF] Spotify search END result=ERROR`);
    spotifyCacheSet(cacheKey, null);
    return null;
  }
}

// ── Run audio providers in parallel ──────────────────────────────────────────

async function runAudioProviders(query: string, track: string, artist: string, signal?: AbortSignal): Promise<AudioResult | null> {
  const promises = [
    tryInvidiousParallel(query, track, artist, signal).then(r => r ?? Promise.reject(new Error('not found'))),
    trySaavnDev(query, track, artist, signal).then(r => r ?? Promise.reject(new Error('not found'))),
    tryJioSaavnDirect(query, track, artist, signal).then(r => r ?? Promise.reject(new Error('not found'))),
  ];
  try {
    return await Promise.any(promises);
  } catch {
    return null;
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const startTime = Date.now();
  const query = cleanSearchQuery(track, artist);
  const cacheKey = normalizeCacheKey(artist, track);

  const cached = audioCacheGet(cacheKey);
  if (cached) {
    console.log(`[PERF] Audio search START artist="${artist}" track="${track}" cache=HIT`);
    console.log(`[PERF] Audio search TOTAL duration=${Date.now() - startTime}ms result=FOUND provider=cache`);
    return cached;
  }

  console.log(`[PERF] Audio search START artist="${artist}" track="${track}" query="${query}"`);

  const variants = buildQueryVariants(track, artist);

  // Round 1: Try all providers + Spotify in parallel
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const signal = controller.signal;

  console.log(`[PERF] Provider START name="invidious" query="${query}"`);
  console.log(`[PERF] Provider START name="saavn" query="${query}"`);
  console.log(`[PERF] Provider START name="jiosaavn" query="${query}"`);
  console.log(`[PERF] Spotify search START query="${query}"`);

  const round1Audio = runAudioProviders(query, track, artist, signal);
  const round1Spotify = trySpotifyMetadata(query, track, artist, signal);

  const [audioResult, spotifyResult] = await Promise.all([round1Audio, round1Spotify]);
  clearTimeout(timer);

  if (audioResult) {
    console.log(`[PERF] Audio search FIRST_RESULT duration=${Date.now() - startTime}ms`);
    console.log(`[PERF] Audio search TOTAL duration=${Date.now() - startTime}ms result=FOUND`);
    audioResult.spotifyUrl = spotifyResult?.spotifyUrl;
    audioCacheSet(cacheKey, audioResult);
    return audioResult;
  }

  // Round 2: If Spotify found metadata, retry audio search with normalized query
  if (spotifyResult) {
    const spotifyQuery = `${spotifyResult.title} ${spotifyResult.artist}`.trim();
    console.log(`[PERF] Audio retry using Spotify metadata START artist="${spotifyResult.artist}" title="${spotifyResult.title}"`);

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), PROVIDER_TIMEOUT_MS);
    const retryResult = await runAudioProviders(spotifyQuery, spotifyResult.title, spotifyResult.artist, controller2.signal);
    clearTimeout(timer2);

    if (retryResult) {
      console.log(`[PERF] Audio retry using Spotify metadata END result=FOUND duration=${Date.now() - startTime}ms`);
      console.log(`[PERF] Audio search TOTAL duration=${Date.now() - startTime}ms result=FOUND`);
      retryResult.spotifyUrl = spotifyResult.spotifyUrl;
      audioCacheSet(cacheKey, retryResult);
      return retryResult;
    }
    console.log(`[PERF] Audio retry using Spotify metadata END result=FAILED duration=${Date.now() - startTime}ms`);
  }

  console.log(`[PERF] Audio search FAILED reason="all providers exhausted" totalMs=${Date.now() - startTime}`);

  if (spotifyResult) {
    throw new SpotifyFallbackError(
      `Audio not found but Spotify track exists: ${spotifyResult.title} — ${spotifyResult.artist}`,
      spotifyResult.spotifyUrl,
      spotifyResult.title,
      spotifyResult.artist,
    );
  }

  throw new AudioSourceError(`No audio results found for "${query}".`);
}
