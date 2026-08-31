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
 * Checks whether a given URL string is an Instagram page URL (post, reel, etc.),
 * rather than a direct downloadable media asset URL.
 */
export function isInstagramPageUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
      const pathname = parsed.pathname.toLowerCase();
      if (
        pathname.startsWith('/reel/') ||
        pathname.startsWith('/reels/') ||
        pathname.startsWith('/p/') ||
        pathname.startsWith('/tv/') ||
        pathname.startsWith('/share/') ||
        pathname.startsWith('/stories/') ||
        pathname === '/'
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Validates that a candidate URL string is a valid HTTP(S) URL and NOT an Instagram page URL.
 */
export function isValidMediaUrl(urlStr: unknown): urlStr is string {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  if (isInstagramPageUrl(trimmed)) return false;
  return true;
}

/**
 * Recursively redacts sensitive fields (access keys, tokens, secrets) for safe logging.
 */
export function sanitizeForLog(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForLog);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('password')
    ) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeForLog(value);
    }
  }
  return sanitized;
}

/**
 * Extracts valid direct media candidate URLs from SocialKit response structure.
 */
function extractMediaUrls(responseBody: any): { videoUrl?: string; audioUrl?: string } {
  let videoUrl: string | undefined;
  let audioUrl: string | undefined;

  const payloads = [
    responseBody?.data,
    responseBody?.result,
    responseBody?.payload,
    responseBody,
  ].filter(Boolean);

  for (const payload of payloads) {
    // 1. Check audio candidate fields
    if (!audioUrl) {
      const audioFields = [
        payload.audio_url,
        payload.audioUrl,
        payload.music_url,
        payload.musicUrl,
        payload.audio,
        payload.mp3_url,
        payload.mp3,
      ];
      for (const cand of audioFields) {
        if (isValidMediaUrl(cand)) {
          audioUrl = cand;
          break;
        }
      }
    }

    // 2. Check video / direct media candidate fields
    if (!videoUrl) {
      const videoFields = [
        payload.video_url,
        payload.videoUrl,
        payload.download_url,
        payload.downloadUrl,
        payload.direct_url,
        payload.directUrl,
        payload.media_url,
        payload.mediaUrl,
        payload.video,
        payload.src,
        payload.link,
      ];
      for (const cand of videoFields) {
        if (isValidMediaUrl(cand)) {
          videoUrl = cand;
          break;
        }
      }
    }

    // 3. Check array candidate fields (urls, medias, videos, links)
    const arrayCandidates = [
      payload.urls,
      payload.medias,
      payload.videos,
      payload.links,
      Array.isArray(payload) ? payload : null,
    ].filter(Array.isArray);

    for (const arr of arrayCandidates) {
      for (const item of arr) {
        if (typeof item === 'string' && isValidMediaUrl(item)) {
          if (!videoUrl) videoUrl = item;
        } else if (item && typeof item === 'object') {
          const itemAudio =
            item.audio_url || item.audioUrl || item.music_url || item.audio || item.mp3;
          const itemVideo =
            item.video_url || item.videoUrl || item.download_url || item.media_url || item.url || item.link;

          if (!audioUrl && isValidMediaUrl(itemAudio)) {
            audioUrl = itemAudio;
          }
          if (!videoUrl && isValidMediaUrl(itemVideo)) {
            videoUrl = itemVideo;
          }
        }
      }
    }

    // 4. Fallback to generic 'url' field ONLY if it is a valid direct media URL (not an Instagram page URL!)
    if (!videoUrl && isValidMediaUrl(payload.url)) {
      videoUrl = payload.url;
    }
  }

  return { videoUrl, audioUrl };
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

  logger.info('Instagram request started', { shortcode, url: normalizedUrl });

  try {
    const requestBody = {
      access_key: apiKey,
      url: normalizedUrl,
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

    // Log SocialKit response structure safely without logging API keys
    logger.info('SocialKit response received', { response: sanitizeForLog(data) });

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

    const { videoUrl, audioUrl } = extractMediaUrls(data);

    const payload = data.data || data.result || data;

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
      logger.error('Failed to extract direct media URL from SocialKit API response.', {
        response: sanitizeForLog(data),
      });

      const rawMsg = data.message || data.error || '';
      const msgLower = String(rawMsg).toLowerCase();
      if (
        data.status === 404 ||
        msgLower.includes('private') ||
        msgLower.includes('not found')
      ) {
        throw new PrivateOrDeletedReelError();
      }
      throw new InstagramApiError('Could not find downloadable direct media URL in SocialKit response.');
    }

    logger.info('Instagram direct media URL received', { shortcode, mediaUrl: finalMediaUrl });

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

