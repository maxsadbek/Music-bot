import axios from 'axios';
import { logger } from '../utils/logger';
import { validateAndNormalizeInstagramUrl } from '../validation/instagram';
import {
  InstagramApiError,
  PrivateOrDeletedReelError,
} from '../utils/errors';

export interface InstagramReelMedia {
  id: string;
  mediaUrl: string;
  audioUrl?: string;
  title?: string;
  thumbnailUrl?: string;
  duration?: number;
}

/**
 * Service abstraction for retrieving Instagram Reel video and media URLs.
 * Separated cleanly so provider implementations can be swapped without touching bot logic.
 */
export async function getInstagramReel(url: string): Promise<InstagramReelMedia> {
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);

  const apiUrl = process.env.INSTAGRAM_API_URL;
  const apiKey = process.env.INSTAGRAM_API_KEY;

  if (!apiUrl) {
    logger.warn('INSTAGRAM_API_URL is not defined in environment variables');
    throw new InstagramApiError('Instagram API endpoint is not configured. Please set INSTAGRAM_API_URL in environment.');
  }

  logger.info(`Fetching Reel media for shortcode: ${shortcode}`);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['X-RapidAPI-Key'] = apiKey;
      headers['x-api-key'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await axios.get(apiUrl, {
      params: {
        url: normalizedUrl,
        shortcode,
      },
      headers,
      timeout: 12000,
    });

    const data = response.data;

    if (!data) {
      throw new InstagramApiError('Empty response from Instagram extraction service.');
    }

    // Flexible extraction mapping to support standard RapidAPI & generic media APIs
    const videoUrl =
      data.video_url ||
      data.media_url ||
      data.url ||
      data.download_url ||
      (Array.isArray(data.urls) && data.urls[0]?.url) ||
      (Array.isArray(data.data) && data.data[0]?.url) ||
      (data.result && (data.result.video_url || data.result.url || data.result[0]?.url));

    const audioUrl =
      data.audio_url ||
      data.music_url ||
      (data.result && (data.result.audio_url || data.result.music_url));

    const thumbnailUrl =
      data.thumbnail_url ||
      data.cover_url ||
      data.thumbnail ||
      (data.result && data.result.thumbnail);

    const title =
      data.title ||
      data.caption ||
      (data.result && (data.result.title || data.result.caption));

    if (!videoUrl) {
      // If videoUrl extraction fails and DEBUG_INSTAGRAM_API=true, log sanitized raw data
      if (process.env.DEBUG_INSTAGRAM_API === 'true') {
        logger.error('Failed to extract videoUrl from Instagram API response. Raw response:', JSON.stringify(data));
      }

      if (
        data.status === 404 ||
        data.error?.includes('private') ||
        data.message?.includes('private') ||
        data.message?.includes('not found')
      ) {
        throw new PrivateOrDeletedReelError();
      }
      throw new InstagramApiError('Could not find downloadable media URL in response.');
    }

    return {
      id: shortcode,
      mediaUrl: videoUrl,
      audioUrl: audioUrl || undefined,
      title: title || undefined,
      thumbnailUrl: thumbnailUrl || undefined,
    };
  } catch (error: unknown) {
    if (error instanceof PrivateOrDeletedReelError || error instanceof InstagramApiError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.message;

      logger.error(`Instagram API HTTP error [${status}]`, errorMsg);

      if (status === 404 || status === 403) {
        throw new PrivateOrDeletedReelError();
      }

      throw new InstagramApiError(`Extraction provider returned HTTP ${status || 'error'}: ${errorMsg}`);
    }

    logger.error('Unexpected error fetching Instagram Reel', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}
