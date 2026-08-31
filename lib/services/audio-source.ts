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
 * Acquires the actual audio file for a given track and artist.
 *
 * This is the audio acquisition layer, intentionally separated from ACRCloud
 * (which is recognition-only). This function searches for and downloads
 * the actual audio content that can be sent to Telegram as a playable audio message.
 *
 * Current implementation uses the JioSaavn search + download API via the
 * public saavn.dev API. This can be swapped for any other legal audio source
 * without affecting the rest of the bot.
 */
export async function getSongAudio(track: string, artist: string): Promise<AudioResult> {
  const query = `${track} ${artist}`;
  logger.info('Audio source: searching for track', { track, artist });

  // 1. Search for the song
  const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=5`;

  let downloadUrl: string | undefined;
  let songTitle = track;
  let songArtist = artist;
  let durationSeconds: number | undefined;

  try {
    const searchResponse = await axios.get(searchUrl, { timeout: 10000 });
    const results = searchResponse.data?.data?.results;

    if (!results || !Array.isArray(results) || results.length === 0) {
      throw new AudioSourceError(`No audio results found for "${query}".`);
    }

    // Find best match by checking title/artist similarity
    const match = results.find((r: any) => {
      const rTitle = (r.name || r.title || '').toLowerCase();
      const rArtist = (
        r.artists?.primary?.map((a: any) => a.name).join(', ') ||
        r.primaryArtists ||
        r.artist ||
        ''
      ).toLowerCase();
      return (
        rTitle.includes(track.toLowerCase()) ||
        track.toLowerCase().includes(rTitle)
      ) && (
        rArtist.includes(artist.split(',')[0].trim().toLowerCase()) ||
        artist.split(',')[0].trim().toLowerCase().includes(rArtist.split(',')[0].trim())
      );
    }) || results[0]; // Fall back to first result

    // Extract the highest quality download URL from the response
    const downloadLinks = match.downloadUrl || match.download_url || [];
    if (Array.isArray(downloadLinks) && downloadLinks.length > 0) {
      // Pick highest quality (last item is typically highest)
      const best = downloadLinks[downloadLinks.length - 1];
      downloadUrl = best.url || best.link || best;
    }

    if (!downloadUrl) {
      throw new AudioSourceError('No download URL found in audio source response.');
    }

    songTitle = match.name || match.title || track;
    const primaryArtists = match.artists?.primary?.map((a: any) => a.name).join(', ');
    songArtist = primaryArtists || match.primaryArtists || match.artist || artist;
    durationSeconds = match.duration ? parseInt(match.duration, 10) : undefined;

    logger.info('Audio source: match found', { songTitle, songArtist, downloadUrl: downloadUrl.slice(0, 80) });
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    logger.error('Audio source: search failed', error);
    throw new AudioSourceError('Failed to search for audio track.');
  }

  // 2. Download the actual audio file
  try {
    logger.info('Audio source: downloading audio file');
    const audioResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const buffer = Buffer.from(audioResponse.data);
    if (!buffer || buffer.length === 0) {
      throw new AudioSourceError('Downloaded audio file is empty.');
    }

    // Verify it's not HTML
    const head = buffer.subarray(0, 100).toString('utf-8').trim().toLowerCase();
    if (head.includes('<html') || head.includes('<!doctype')) {
      throw new AudioSourceError('Audio source returned HTML instead of audio data.');
    }

    logger.info('Audio source: download complete', { size: buffer.length });

    return {
      buffer,
      title: songTitle,
      artist: songArtist,
      durationSeconds,
    };
  } catch (error: unknown) {
    if (error instanceof AudioSourceError) throw error;
    logger.error('Audio source: download failed', error);
    throw new AudioSourceError('Failed to download audio file.');
  }
}
