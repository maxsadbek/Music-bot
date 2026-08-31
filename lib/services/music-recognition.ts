import axios from 'axios';
import { logger } from '../utils/logger';
import {
  MusicNotFoundError,
  MusicRecognitionApiError,
} from '../utils/errors';

export interface SongResult {
  title: string;
  artist: string;
  album?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  appleMusicUrl?: string;
}

/**
 * Identifies a song from an audio or video media URL using AudD Music Recognition API.
 */
export async function identifySong(audioOrVideoUrl: string): Promise<SongResult> {
  const apiToken = process.env.AUDD_API_TOKEN;

  if (!apiToken) {
    logger.warn('AUDD_API_TOKEN is not defined in environment variables');
    throw new MusicRecognitionApiError('AudD API token is missing in environment variables.');
  }

  logger.info('Sending media URL to AudD Music Recognition API');

  try {
    const formData = new URLSearchParams();
    formData.append('api_token', apiToken);
    formData.append('url', audioOrVideoUrl);
    formData.append('return', 'apple_music,spotify');

    const response = await axios.post('https://api.audd.io/', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000, // 20 second timeout for recognition
    });

    const data = response.data;

    if (!data) {
      throw new MusicRecognitionApiError('Received empty response from AudD API.');
    }

    if (data.status === 'error') {
      const errorMsg = data.error?.error_message || 'AudD returned error status';
      logger.error('AudD API response error:', errorMsg);
      throw new MusicRecognitionApiError(errorMsg);
    }

    if (!data.result) {
      logger.info('No song match returned by AudD API');
      throw new MusicNotFoundError();
    }

    const res = data.result;

    const title = res.title?.trim();
    const artist = res.artist?.trim();

    if (!title || !artist) {
      throw new MusicNotFoundError();
    }

    const album = res.album?.trim();
    const releaseDate = res.release_date?.trim();

    // Extract Spotify URL
    let spotifyUrl: string | undefined = undefined;
    if (res.spotify?.external_urls?.spotify) {
      spotifyUrl = res.spotify.external_urls.spotify;
    } else if (res.spotify?.link) {
      spotifyUrl = res.spotify.link;
    }

    // Extract Apple Music URL
    let appleMusicUrl: string | undefined = undefined;
    if (res.apple_music?.url) {
      appleMusicUrl = res.apple_music.url;
    }

    const songResult: SongResult = {
      title,
      artist,
      album: album || undefined,
      releaseDate: releaseDate || undefined,
      spotifyUrl: spotifyUrl || undefined,
      appleMusicUrl: appleMusicUrl || undefined,
    };

    logger.info(`Song successfully identified: ${songResult.artist} - ${songResult.title}`);
    return songResult;
  } catch (error: unknown) {
    if (error instanceof MusicNotFoundError || error instanceof MusicRecognitionApiError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      logger.error('AudD API HTTP error', error.message);
      throw new MusicRecognitionApiError(`AudD HTTP error: ${error.message}`);
    }

    logger.error('Unexpected error in music recognition', error);
    throw new MusicRecognitionApiError('Failed to execute music recognition.');
  }
}
