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

/** Invidious instances for YouTube search (rotated on failure). */
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://vid.puffyan.us',
  'https://invidious.nerdvpn.de',
];

const REQUEST_TIMEOUT = 12_000;

/**
 * Finds the best matching song from search results by comparing title and artist.
 */
function findBestMatch(results: unknown[], track: string, artist: string): unknown | null {
  const lowerTrack = track.toLowerCase();
  const lowerArtist = artist.split(',')[0].trim().toLowerCase();

  const scored = results
    .map((r: any) => {
      const rTitle = (r.title || r.name || r.song || '').toLowerCase();
      // For Invidious results the artist is usually in the title, e.g. "Artist - Title (Official Video)"
      const rArtist = (
        r.artists?.primary?.map((a: any) => a.name).join(', ') ||
        r.primaryArtists || r.singers || r.artist ||
        (rTitle.includes(' - ') ? rTitle.split(' - ')[0] : '')
      ).toLowerCase().trim();

      let score = 0;

      // Title match scoring
      if (rTitle === lowerTrack) score += 10;
      else if (rTitle.includes(lowerTrack) || lowerTrack.includes(rTitle)) score += 7;
      else {
        // Partial word overlap
        const trackWords = lowerTrack.split(/\s+/);
        const titleWords = rTitle.split(/\s+/);
        const commonWords = trackWords.filter((w: string) => titleWords.some((tw: string) => tw.includes(w) || w.includes(tw)));
        score += commonWords.length * 2;
      }

      // Artist match scoring
      if (rArtist && lowerArtist) {
        if (rArtist.includes(lowerArtist) || lowerArtist.includes(rArtist.split(',')[0].trim())) {
          score += 5;
        }
      }

      return { result: r, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 2) {
    return best.result;
  }
  return scored[0]?.result || null;
}

/**
 * Extracts the best download URL from a saavn/JioSaavn search result.
 */
function extractDownloadUrl(match: any): string | undefined {
  const downloadLinks = match.downloadUrl || match.download_url;
  if (Array.isArray(downloadLinks) && downloadLinks.length > 0) {
    const best = downloadLinks[downloadLinks.length - 1];
    return best.url || best.link || best;
  }
  return undefined;
}

/**
 * Extracts metadata from a saavn/JioSaavn search result object.
 */
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

/**
 * Downloads audio from a URL and validates it's actual audio data (not HTML).
 */
async function downloadAudioBuffer(url: string, timeout = 20_000): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const buffer = Buffer.from(response.data);
  if (!buffer || buffer.length === 0) {
    throw new AudioSourceError('Downloaded audio file is empty.');
  }

  const head = buffer.subarray(0, 100).toString('utf-8').trim().toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) {
    throw new AudioSourceError('Audio source returned HTML instead of audio data.');
  }

  return buffer;
}

// ─── Provider 1: Invidious (YouTube search + download) ───────────────────────

interface InvidiousVideo {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  type: string;
}

/**
 * Try searching YouTube via Invidious API and download audio.
 * This provider has virtually all music since YouTube is the world's largest music catalog.
 */
async function tryInvidiousYouTube(
  query: string,
  track: string,
  artist: string,
): Promise<AudioResult | null> {
  const startTime = Date.now();

  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      logger.info('[MUSIC_DL] Invidious YouTube search started', { query, instance });

      const searchUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`;
      const searchResponse = await axios.get<InvidiousVideo[]>(searchUrl, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const videos = searchResponse.data;
      if (!videos || !Array.isArray(videos) || videos.length === 0) {
        logger.warn('[MUSIC_DL] Invidious: no search results', {
          query,
          instance,
          duration: `${Date.now() - startTime}ms`,
        });
        continue; // try next instance
      }

      const match = findBestMatch(videos, track, artist) as InvidiousVideo | null;
      if (!match) {
        logger.warn('[MUSIC_DL] Invidious: no good match found', {
          query,
          resultCount: videos.length,
          instance,
          duration: `${Date.now() - startTime}ms`,
        });
        continue;
      }

      // Get video info which contains audio stream URLs
      const videoInfoUrl = `${instance}/api/v1/videos/${match.videoId}?fields=title,author,lengthSeconds,adaptiveFormats`;
      const infoResponse = await axios.get(videoInfoUrl, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const videoInfo = infoResponse.data;
      const adaptiveFormats = videoInfo.adaptiveFormats || [];

      // Find the best audio-only stream (prefer opus > mp4a > any audio)
      const audioFormats = adaptiveFormats.filter(
        (f: any) => f.type?.startsWith('audio/') && f.url,
      );

      if (audioFormats.length === 0) {
        logger.warn('[MUSIC_DL] Invidious: no audio streams found', {
          videoId: match.videoId,
          instance,
          duration: `${Date.now() - startTime}ms`,
        });
        continue;
      }

      // Prefer opus (best quality/size), then m4a
      const audioFormat =
        audioFormats.find((f: any) => f.type?.includes('opus')) ||
        audioFormats.find((f: any) => f.type?.includes('mp4a')) ||
        audioFormats[audioFormats.length - 1];

      logger.info('[MUSIC_DL] Invidious audio stream found', {
        videoId: match.videoId,
        title: videoInfo.title,
        type: audioFormat.type,
        instance,
        duration: `${Date.now() - startTime}ms`,
      });

      const buffer = await downloadAudioBuffer(audioFormat.url, 30_000);

      logger.info('[MUSIC_DL] Invidious download complete', {
        title: track,
        artist: artist,
        size: buffer.length,
        duration: `${Date.now() - startTime}ms`,
      });

      return {
        buffer,
        title: videoInfo.title || track,
        artist: videoInfo.author || artist,
        durationSeconds: videoInfo.lengthSeconds || undefined,
      };
    } catch (error: unknown) {
      if (error instanceof AudioSourceError) throw error;
      logger.warn('[MUSIC_DL] Invidious instance failed', {
        instance,
        error: error instanceof Error ? error.message : String(error),
        duration: `${Date.now() - startTime}ms`,
      });
      // continue to next instance
    }
  }

  logger.warn('[MUSIC_DL] Invidious: all instances exhausted', {
    query,
    duration: `${Date.now() - startTime}ms`,
  });
  return null;
}

// ─── Provider 2: saavn.dev ────────────────────────────────────────────────────

/**
 * Try searching and downloading from saavn.dev API.
 */
async function trySaavnDev(
  query: string,
  track: string,
  artist: string,
): Promise<AudioResult | null> {
  const startTime = Date.now();

  try {
    logger.info('[MUSIC_DL] saavn.dev search started', { query });

    const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=5`;
    const searchResponse = await axios.get(searchUrl, { timeout: REQUEST_TIMEOUT });
    const results = searchResponse.data?.data?.results;

    if (!results || !Array.isArray(results) || results.length === 0) {
      logger.warn('[MUSIC_DL] saavn.dev: no search results', {
        query,
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    const match = findBestMatch(results, track, artist);
    if (!match) {
      logger.warn('[MUSIC_DL] saavn.dev: no good match', {
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    const downloadUrl = extractDownloadUrl(match);
    if (!downloadUrl) {
      logger.warn('[MUSIC_DL] saavn.dev: no download URL in result', {
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    logger.info('[MUSIC_DL] saavn.dev download URL received', {
      duration: `${Date.now() - startTime}ms`,
    });

    const buffer = await downloadAudioBuffer(downloadUrl);
    const metadata = extractMetadata(match, track, artist);

    logger.info('[MUSIC_DL] saavn.dev download complete', {
      title: metadata.title,
      artist: metadata.artist,
      size: buffer.length,
      duration: `${Date.now() - startTime}ms`,
    });

    return {
      buffer,
      title: metadata.title,
      artist: metadata.artist,
      durationSeconds: metadata.durationSeconds,
    };
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    logger.warn('[MUSIC_DL] saavn.dev failed', {
      error: error instanceof Error ? error.message : String(error),
      duration: `${Date.now() - startTime}ms`,
    });
    return null;
  }
}

// ─── Provider 3: JioSaavn direct API ─────────────────────────────────────────

/**
 * Try searching and downloading from JioSaavn direct API (fallback).
 */
async function tryJioSaavnDirect(
  query: string,
  track: string,
  artist: string,
): Promise<AudioResult | null> {
  const startTime = Date.now();

  try {
    logger.info('[MUSIC_DL] JioSaavn direct search started', { query });

    const searchResponse = await axios.get('https://www.jiosaavn.com/api.php', {
      params: {
        __call: 'search.getResults',
        _format: 'json',
        _marker: 0,
        api_version: 4,
        ctx: 'web6dot0',
        query,
        n: 5,
        p: 1,
      },
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const results = searchResponse.data?.results;
    if (!results || !Array.isArray(results) || results.length === 0) {
      logger.warn('[MUSIC_DL] JioSaavn direct: no search results', {
        query,
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    const match = findBestMatch(results, track, artist);
    if (!match) {
      logger.warn('[MUSIC_DL] JioSaavn direct: no good match', {
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    const downloadUrl = extractDownloadUrl(match);
    if (!downloadUrl) {
      logger.warn('[MUSIC_DL] JioSaavn direct: no download URL', {
        duration: `${Date.now() - startTime}ms`,
      });
      return null;
    }

    logger.info('[MUSIC_DL] JioSaavn direct download URL received', {
      duration: `${Date.now() - startTime}ms`,
    });

    const buffer = await downloadAudioBuffer(downloadUrl);
    const metadata = extractMetadata(match, track, artist);

    logger.info('[MUSIC_DL] JioSaavn direct download complete', {
      title: metadata.title,
      artist: metadata.artist,
      size: buffer.length,
      duration: `${Date.now() - startTime}ms`,
    });

    return {
      buffer,
      title: metadata.title,
      artist: metadata.artist,
      durationSeconds: metadata.durationSeconds,
    };
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    logger.warn('[MUSIC_DL] JioSaavn direct failed', {
      error: error instanceof Error ? error.message : String(error),
      duration: `${Date.now() - startTime}ms`,
    });
    return null;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Finds and downloads the actual audio file for a given track and artist.
 *
 * Provider priority:
 * 1. Invidious/YouTube — largest catalog, virtually all music
 * 2. saavn.dev — good for Indian/South Asian music
 * 3. JioSaavn direct — fallback for Indian/South Asian music
 *
 * Each provider is independent: if one fails, the next is tried.
 * No single provider failure causes the entire request to fail.
 */
export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const query = `${track} ${artist}`;
  const startTime = Date.now();

  logger.info('[MUSIC_DL] Music download requested', { track, artist, query });

  // Provider 1: Invidious/YouTube (largest catalog — has virtually all music)
  const ytResult = await tryInvidiousYouTube(query, track, artist);
  if (ytResult) {
    logger.info('[MUSIC_DL] Music download completed via Invidious/YouTube', {
      duration: `${Date.now() - startTime}ms`,
    });
    return ytResult;
  }

  // Provider 2: saavn.dev (good for Indian/South Asian music)
  const saavnResult = await trySaavnDev(query, track, artist);
  if (saavnResult) {
    logger.info('[MUSIC_DL] Music download completed via saavn.dev', {
      duration: `${Date.now() - startTime}ms`,
    });
    return saavnResult;
  }

  // Provider 3: JioSaavn direct API (fallback)
  const jioResult = await tryJioSaavnDirect(query, track, artist);
  if (jioResult) {
    logger.info('[MUSIC_DL] Music download completed via JioSaavn direct', {
      duration: `${Date.now() - startTime}ms`,
    });
    return jioResult;
  }

  logger.error('[MUSIC_DL] Music download failed: all providers exhausted', {
    query,
    duration: `${Date.now() - startTime}ms`,
  });
  throw new AudioSourceError(`No audio results found for "${query}".`);
}
