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

// ── Timeout: max 5s per provider (search + download combined) ────────────────
const PROVIDER_TIMEOUT = 5_000;

/** Top 3 Invidious instances only. */
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://invidious.nerdvpn.de',
];

/**
 * Cleans a track/artist string to produce better search queries.
 */
function cleanSearchQuery(track: string, artist: string): string {
  const cleanTrack = track.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  const cleanArtist = artist.split(',')[0].split(' feat')[0].split(' ft')[0].split(' &')[0].trim();
  return `${cleanTrack} ${cleanArtist}`.trim();
}

function findBestMatch(results: unknown[], track: string, artist: string): unknown | null {
  const lowerTrack = track.toLowerCase();
  const lowerArtist = artist.split(',')[0].trim().toLowerCase();

  const scored = results
    .map((r: any) => {
      const rTitle = (r.title || r.name || r.song || '').toLowerCase();
      const rArtist = (
        r.artists?.primary?.map((a: any) => a.name).join(', ') ||
        r.primaryArtists || r.singers || r.artist ||
        (rTitle.includes(' - ') ? rTitle.split(' - ')[0] : '')
      ).toLowerCase().trim();

      let score = 0;
      if (rTitle === lowerTrack) score += 10;
      else if (rTitle.includes(lowerTrack) || lowerTrack.includes(rTitle)) score += 7;
      else {
        const trackWords = lowerTrack.split(/\s+/);
        const titleWords = rTitle.split(/\s+/);
        const commonWords = trackWords.filter((w: string) => titleWords.some((tw: string) => tw.includes(w) || w.includes(tw)));
        score += commonWords.length * 2;
      }
      if (rArtist && lowerArtist) {
        if (rArtist.includes(lowerArtist) || lowerArtist.includes(rArtist.split(',')[0].trim())) {
          score += 5;
        }
      }
      return { result: r, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 2) return best.result;
  return scored[0]?.result || null;
}

function extractDownloadUrl(match: any): string | undefined {
  const downloadLinks = match.downloadUrl || match.download_url;
  if (Array.isArray(downloadLinks) && downloadLinks.length > 0) {
    const best = downloadLinks[downloadLinks.length - 1];
    return best.url || best.link || best;
  }
  return undefined;
}

function extractMetadata(match: any, fallbackTrack: string, fallbackArtist: string) {
  const title = match.name || match.title || match.song || fallbackTrack;
  let artist: string;
  if (match.artists?.primary) {
    artist = match.artists.primary.map((a: any) => a.name).join(', ');
  } else {
    artist = match.primaryArtists || match.singers || match.artist || fallbackArtist;
  }
  const durationSeconds = match.duration ? parseInt(match.duration, 10) : undefined;
  return { title, artist, durationSeconds };
}

async function downloadAudioBuffer(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: PROVIDER_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const buffer = Buffer.from(response.data);
  if (!buffer || buffer.length === 0) throw new AudioSourceError('Downloaded audio file is empty.');
  const head = buffer.subarray(0, 100).toString('utf-8').trim().toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) {
    throw new AudioSourceError('Audio source returned HTML instead of audio data.');
  }
  return buffer;
}

// ─── Provider 1: Invidious (YouTube) ─────────────────────────────────────────

interface InvidiousVideo {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  type: string;
}

async function tryInvidiousYouTube(query: string, track: string, artist: string): Promise<AudioResult | null> {
  const startTime = Date.now();

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[PERF] Audio provider 1 (Invidious) START instance=${instance} query="${query}"`);

      const searchUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`;
      const searchResponse = await axios.get<InvidiousVideo[]>(searchUrl, {
        timeout: PROVIDER_TIMEOUT,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const videos = searchResponse.data;
      if (!videos || !Array.isArray(videos) || videos.length === 0) {
        console.log(`[PERF] Audio provider 1 (Invidious) no results instance=${instance}`);
        continue;
      }

      const match = findBestMatch(videos, track, artist) as InvidiousVideo | null;
      if (!match) {
        console.log(`[PERF] Audio provider 1 (Invidious) no good match instance=${instance} results=${videos.length}`);
        continue;
      }

      const videoInfoUrl = `${instance}/api/v1/videos/${match.videoId}?fields=title,author,lengthSeconds,adaptiveFormats`;
      const infoResponse = await axios.get(videoInfoUrl, {
        timeout: PROVIDER_TIMEOUT,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const videoInfo = infoResponse.data;
      const audioFormats = (videoInfo.adaptiveFormats || []).filter(
        (f: any) => f.type?.startsWith('audio/') && f.url,
      );

      if (audioFormats.length === 0) {
        console.log(`[PERF] Audio provider 1 (Invidious) no audio streams videoId=${match.videoId}`);
        continue;
      }

      const audioFormat =
        audioFormats.find((f: any) => f.type?.includes('opus')) ||
        audioFormats.find((f: any) => f.type?.includes('mp4a')) ||
        audioFormats[audioFormats.length - 1];

      const buffer = await downloadAudioBuffer(audioFormat.url);

      console.log(`[PERF] Audio provider 1 (Invidious) END: ${Date.now() - startTime}ms result=FOUND title=${videoInfo.title}`);
      return {
        buffer,
        title: videoInfo.title || track,
        artist: videoInfo.author || artist,
        durationSeconds: videoInfo.lengthSeconds || undefined,
      };
    } catch (error: unknown) {
      if (error instanceof AudioSourceError) throw error;
      // continue to next instance
    }
  }

  console.log(`[PERF] Audio provider 1 (Invidious) END: ${Date.now() - startTime}ms result=NOT_FOUND`);
  return null;
}

// ─── Provider 2: saavn.dev ───────────────────────────────────────────────────

async function trySaavnDev(query: string, track: string, artist: string): Promise<AudioResult | null> {
  const startTime = Date.now();
  console.log(`[PERF] Audio provider 2 (saavn.dev) START query="${query}"`);

  try {
    const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=5`;
    const searchResponse = await axios.get(searchUrl, { timeout: PROVIDER_TIMEOUT });
    const results = searchResponse.data?.data?.results;

    if (!results || !Array.isArray(results) || results.length === 0) {
      console.log(`[PERF] Audio provider 2 (saavn.dev) END: ${Date.now() - startTime}ms result=NOT_FOUND`);
      return null;
    }

    const match = findBestMatch(results, track, artist);
    if (!match) {
      console.log(`[PERF] Audio provider 2 (saavn.dev) END: ${Date.now() - startTime}ms result=NO_MATCH`);
      return null;
    }

    const downloadUrl = extractDownloadUrl(match);
    if (!downloadUrl) {
      console.log(`[PERF] Audio provider 2 (saavn.dev) END: ${Date.now() - startTime}ms result=NO_URL`);
      return null;
    }

    const buffer = await downloadAudioBuffer(downloadUrl);
    const metadata = extractMetadata(match, track, artist);

    console.log(`[PERF] Audio provider 2 (saavn.dev) END: ${Date.now() - startTime}ms result=FOUND title=${metadata.title}`);
    return { buffer, title: metadata.title, artist: metadata.artist, durationSeconds: metadata.durationSeconds };
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    console.log(`[PERF] Audio provider 2 (saavn.dev) END: ${Date.now() - startTime}ms result=ERROR msg=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ─── Provider 3: JioSaavn direct ─────────────────────────────────────────────

async function tryJioSaavnDirect(query: string, track: string, artist: string): Promise<AudioResult | null> {
  const startTime = Date.now();
  console.log(`[PERF] Audio provider 3 (JioSaavn) START query="${query}"`);

  try {
    const searchResponse = await axios.get('https://www.jiosaavn.com/api.php', {
      params: { __call: 'search.getResults', _format: 'json', _marker: 0, api_version: 4, ctx: 'web6dot0', query, n: 5, p: 1 },
      timeout: PROVIDER_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const results = searchResponse.data?.results;
    if (!results || !Array.isArray(results) || results.length === 0) {
      console.log(`[PERF] Audio provider 3 (JioSaavn) END: ${Date.now() - startTime}ms result=NOT_FOUND`);
      return null;
    }

    const match = findBestMatch(results, track, artist);
    if (!match) {
      console.log(`[PERF] Audio provider 3 (JioSaavn) END: ${Date.now() - startTime}ms result=NO_MATCH`);
      return null;
    }

    const downloadUrl = extractDownloadUrl(match);
    if (!downloadUrl) {
      console.log(`[PERF] Audio provider 3 (JioSaavn) END: ${Date.now() - startTime}ms result=NO_URL`);
      return null;
    }

    const buffer = await downloadAudioBuffer(downloadUrl);
    const metadata = extractMetadata(match, track, artist);

    console.log(`[PERF] Audio provider 3 (JioSaavn) END: ${Date.now() - startTime}ms result=FOUND title=${metadata.title}`);
    return { buffer, title: metadata.title, artist: metadata.artist, durationSeconds: metadata.durationSeconds };
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    console.log(`[PERF] Audio provider 3 (JioSaavn) END: ${Date.now() - startTime}ms result=ERROR msg=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Finds and downloads the actual audio file for a given track and artist.
 * Sequential: Invidious → saavn.dev → JioSaavn. Each max 5s.
 */
export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const startTime = Date.now();
  const query = cleanSearchQuery(track, artist);

  console.log(`[PERF] Audio search START artist="${artist}" track="${track}" query="${query}"`);

  // Provider 1: Invidious/YouTube
  const ytResult = await tryInvidiousYouTube(query, track, artist);
  if (ytResult) {
    console.log(`[PERF] Audio search TOTAL: ${Date.now() - startTime}ms result=FOUND provider=invidious`);
    return ytResult;
  }

  // Provider 2: saavn.dev
  const saavnResult = await trySaavnDev(query, track, artist);
  if (saavnResult) {
    console.log(`[PERF] Audio search TOTAL: ${Date.now() - startTime}ms result=FOUND provider=saavn`);
    return saavnResult;
  }

  // Provider 3: JioSaavn direct
  const jioResult = await tryJioSaavnDirect(query, track, artist);
  if (jioResult) {
    console.log(`[PERF] Audio search TOTAL: ${Date.now() - startTime}ms result=FOUND provider=jiosaavn`);
    return jioResult;
  }

  console.log(`[PERF] Audio search FAILED reason="all providers exhausted" totalMs=${Date.now() - startTime}`);
  throw new AudioSourceError(`No audio results found for "${query}".`);
}
