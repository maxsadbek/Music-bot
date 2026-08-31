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

  const apiUrl = process.env.INSTAGRAM_API_URL || 'https://api.socialkit.dev/instagram/download';
  const apiKey = process.env.INSTAGRAM_API_KEY;

  if (!apiKey) {
    logger.warn('INSTAGRAM_API_KEY is not defined in environment variables');
    throw new InstagramApiError('Instagram API access key is missing. Please set INSTAGRAM_API_KEY in environment.');
  }

  logger.info(`Fetching Reel media for shortcode: ${shortcode}`);

  try {
    const requestBody = {
      access_key: apiKey,
      url: normalizedUrl,
      format: 'mp3',
    };

    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const data = response.data;

    if (!data) {
      throw new InstagramApiError('Empty response from SocialKit Instagram service.');
    }

    if (data.success === false || data.status === 'error') {
      const msg = data.message || data.error || 'SocialKit API returned failure status';
      logger.error('SocialKit API error response:', msg);

      const msgLower = String(msg).toLowerCase();
      if (
        msgLower.includes('private') ||
        msgLower.includes('not found') ||
        msgLower.includes('deleted')
      ) {
        throw new PrivateOrDeletedReelError();
      }
      throw new InstagramApiError(`SocialKit API error: ${msg}`);
    }

    const payload = data.data || data.result || data;

    const videoUrl =
      payload.video_url ||
      payload.media_url ||
      payload.url ||
      payload.download_url ||
      (Array.isArray(payload.urls) && (payload.urls[0]?.url || payload.urls[0])) ||
      (Array.isArray(payload) && (payload[0]?.video_url || payload[0]?.url || payload[0]?.media_url)) ||
      data.video_url ||
      data.media_url ||
      data.url ||
      data.download_url;

    const audioUrl =
      payload.audio_url ||
      payload.music_url ||
      payload.audio ||
      data.audio_url ||
      data.music_url ||
      data.audio;

    const thumbnailUrl =
      payload.thumbnail_url ||
      payload.cover_url ||
      payload.thumbnail ||
      data.thumbnail_url ||
      data.cover_url ||
      data.thumbnail;

    const title =
      payload.title ||
      payload.caption ||
      data.title ||
      data.caption;

    const finalMediaUrl = videoUrl || audioUrl;

    if (!finalMediaUrl) {
      if (process.env.DEBUG_INSTAGRAM_API === 'true') {
        logger.error('Failed to extract media URL from SocialKit API response. Raw response:', JSON.stringify(data));
      }

      const rawMsg = data.message || data.error || '';
      const msgLower = String(rawMsg).toLowerCase();
      if (
        data.status === 404 ||
        msgLower.includes('private') ||
        msgLower.includes('not found')
      ) {
        throw new PrivateOrDeletedReelError();
      }
      throw new InstagramApiError('Could not find downloadable media URL in SocialKit response.');
    }

    return {
      id: shortcode,
      mediaUrl: finalMediaUrl,
      audioUrl: audioUrl || undefined,
      title: title || undefined,
      thumbnailUrl: thumbnailUrl || undefined,
    };
  } catch (error: unknown) {
    if (
      error instanceof PrivateOrDeletedReelError ||
      error instanceof InstagramApiError
    ) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const responseData = error.response?.data;
      const errorMsg = responseData?.message || responseData?.error || error.message;

      logger.error(`SocialKit Instagram API HTTP error [${status || 'network'}]`, errorMsg);

      const msgLower = String(errorMsg).toLowerCase();
      if (status === 404 || status === 403 || msgLower.includes('private') || msgLower.includes('not found')) {
        throw new PrivateOrDeletedReelError();
      }

      throw new InstagramApiError(`SocialKit API returned HTTP ${status || 'error'}: ${errorMsg}`);
    }

    logger.error('Unexpected error fetching Instagram Reel from SocialKit', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}
