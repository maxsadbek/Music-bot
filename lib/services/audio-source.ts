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

/**
 * Finds the best matching song from search results by comparing title and artist.
 */
function findBestMatch(results: any[], track: string, artist: string): any {
  const lowerTrack = track.toLowerCase();
  const lowerArtist = artist.split(',')[0].trim().toLowerCase();

  return results.find((r: any) => {
    const rTitle = (r.name || r.title || r.song || '').toLowerCase();
    const rArtist = (
      r.artists?.primary?.map((a: any) => a.name).join(', ') ||
      r.primaryArtists || r.singers || r.artist || ''
    ).toLowerCase();

    return (
      rTitle.includes(lowerTrack) || lowerTrack.includes(rTitle)
    ) && (
      rArtist.includes(lowerArtist) || lowerArtist.includes(rArtist.split(',')[0].trim())
    );
  }) || results[0];
}

/**
 * Extracts the best download URL from a search result.
 * Handles both saavn.dev and direct JioSaavn response formats.
 */
function extractDownloadUrl(match: any): string | undefined {
  // saavn.dev format: downloadUrl is an array of { url, quality, ... }
  const downloadLinks = match.downloadUrl || match.download_url;
  if (Array.isArray(downloadLinks) && downloadLinks.length > 0) {
    const best = downloadLinks[downloadLinks.length - 1];
    return best.url || best.link || best;
  }

  // Direct JioSaavn format: download_url is an array of { link, quality, ... }
  if (Array.isArray(match.download_url) && match.download_url.length > 0) {
    const best = match.download_url[match.download_url.length - 1];
    return best.link || best.url;
  }

  return undefined;
}

/**
 * Extracts metadata from a search result object.
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
async function downloadAudioBuffer(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const buffer = Buffer.from(response.data);
  if (!buffer || buffer.length === 0) {
    throw new AudioSourceError('Downloaded audio file is empty.');
  }

  // Verify it's not HTML
  const head = buffer.subarray(0, 100).toString('utf-8').trim().toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) {
    throw new AudioSourceError('Audio source returned HTML instead of audio data.');
  }

  return buffer;
}

/**
 * Try searching and downloading from saavn.dev API.
 */
async function trySaavnDev(query: string, track: string, artist: string): Promise<AudioResult | null> {
  const startTime = Date.now();

  try {
    logger.info('[MUSIC_DL] saavn.dev search started', { query });

    const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=5`;
    const searchResponse = await axios.get(searchUrl, { timeout: 10000 });
    const results = searchResponse.data?.data?.results;

    if (!results || !Array.isArray(results) || results.length === 0) {
      logger.warn('[MUSIC_DL] saavn.dev: no search results', { query, duration: `${Date.now() - startTime}ms` });
      return null;
    }

    const match = findBestMatch(results, track, artist);
    const downloadUrl = extractDownloadUrl(match);

    if (!downloadUrl) {
      logger.warn('[MUSIC_DL] saavn.dev: no download URL in result', { duration: `${Date.now() - startTime}ms` });
      return null;
    }

    logger.info('[MUSIC_DL] saavn.dev download URL received', {
      downloadUrl: downloadUrl.slice(0, 80),
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

/**
 * Try searching and downloading from JioSaavn direct API (fallback).
 */
async function tryJioSaavnDirect(query: string, track: string, artist: string): Promise<AudioResult | null> {
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
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const results = searchResponse.data?.results;
    if (!results || !Array.isArray(results) || results.length === 0) {
      logger.warn('[MUSIC_DL] JioSaavn direct: no search results', { query, duration: `${Date.now() - startTime}ms` });
      return null;
    }

    const match = findBestMatch(results, track, artist);
    const downloadUrl = extractDownloadUrl(match);

    if (!downloadUrl) {
      logger.warn('[MUSIC_DL] JioSaavn direct: no download URL', { duration: `${Date.now() - startTime}ms` });
      return null;
    }

    logger.info('[MUSIC_DL] JioSaavn direct download URL received', {
      downloadUrl: downloadUrl.slice(0, 80),
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

/**
 * Acquires the actual audio file for a given track and artist.
 *
 * This is the audio acquisition layer, intentionally separated from ACRCloud
 * (which is recognition-only). This function searches for and downloads
 * the actual audio content that can be sent to Telegram as a playable audio message.
 *
 * Tries saavn.dev API first, then falls back to JioSaavn direct API.
 * This can be swapped for any other legal audio source without affecting
 * the rest of the bot.
 */
export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const query = `${track} ${artist}`;
  const startTime = Date.now();

  logger.info('[MUSIC_DL] Music download requested', { track, artist, query });

  // 1. Try saavn.dev first
  const saavnResult = await trySaavnDev(query, track, artist);
  if (saavnResult) {
    logger.info('[MUSIC_DL] Music download completed via saavn.dev', {
      duration: `${Date.now() - startTime}ms`,
    });
    return saavnResult;
  }

  // 2. Fallback to JioSaavn direct API
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
