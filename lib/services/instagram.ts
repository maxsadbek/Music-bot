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
 * Service abstraction for retrieving Instagram Reel video and media URLs.
 * Separated cleanly so provider implementations can be swapped without touching bot logic.
 */
export async function getInstagramReel(url: string): Promise<InstagramReelMedia> {
  logger.info('[IG DEBUG] getInstagramReel called with URL:', url);
  
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);
  logger.info('[IG DEBUG] SocialKit request starting');

  const apiUrl = process.env.INSTAGRAM_API_URL;
  const apiKey = process.env.INSTAGRAM_API_KEY;

  if (!apiUrl) {
    logger.error('[IG DEBUG] INSTAGRAM_API_URL is not defined in environment variables');
    logger.warn('INSTAGRAM_API_URL is not defined in environment variables');
    throw new InstagramApiError('Instagram API endpoint is not configured. Please set INSTAGRAM_API_URL in environment.');
  }

  if (!apiKey) {
    logger.error('[IG DEBUG] INSTAGRAM_API_KEY is not configured');
    throw new InstagramApiError('Instagram API key is not configured. Please set INSTAGRAM_API_KEY in environment.');
  }

  logger.info('[IG DEBUG] Instagram API request started');
  logger.info('[IG DEBUG] Instagram API key configured: true');
  logger.info('[IG DEBUG] SocialKit API URL:', apiUrl);
  logger.info('[IG DEBUG] Normalized Instagram URL:', normalizedUrl);
  logger.info('[IG DEBUG] Shortcode:', shortcode);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-key': apiKey,
    };

    logger.info('[IG DEBUG] Sending POST request to SocialKit');
    logger.info('[IG DEBUG] Headers:', Object.keys(headers));

    const response = await axios.post(apiUrl, {
      url: normalizedUrl,
      access_key: apiKey,
      format: 'mp4',
      quality: '720p',
    }, {
      headers,
      timeout: 12000,
    });
    logger.info('[IG DEBUG] Instagram API response status:', response.status);
    logger.info('[IG DEBUG] SocialKit request completed');

    const data = response.data;

    if (!data) {
      logger.error('[IG DEBUG] Empty response from SocialKit');
      throw new InstagramApiError('Empty response from Instagram extraction service.');
    }

    // Add diagnostic logging for SocialKit response structure
    logger.info('[IG DEBUG] SocialKit HTTP status:', response.status);
    logger.info('[IG DEBUG] Response Content-Type:', response.headers?.['content-type'] || 'undefined');
    logger.info('[IG DEBUG] Response top-level keys:', Object.keys(data));
    
    // Log nested object keys safely
    const topLevelKeys = Object.keys(data);
    for (const key of topLevelKeys) {
      const value = data[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        logger.info(`[IG DEBUG] nested keys in ${key}:`, Object.keys(value));
      } else if (Array.isArray(value)) {
        logger.info(`[IG DEBUG] ${key} is an array with ${value.length} items`);
        if (value.length > 0 && typeof value[0] === 'object') {
          logger.info(`[IG DEBUG] first item keys in ${key}:`, Object.keys(value[0]));
        }
      }
    }

    // Log provider status/message/error fields
    if (data.status) {
      logger.info('[IG DEBUG] Provider status field:', data.status);
    }
    if (data.message) {
      logger.info('[IG DEBUG] Provider message field:', data.message);
    }
    if (data.error) {
      logger.info('[IG DEBUG] Provider error field:', data.error);
    }

    // Log SocialKit response structure safely without logging API keys
    logger.info('[IG DEBUG] Full sanitized response:', sanitizeForLog(data));

    // Flexible extraction mapping to support SocialKit API responses.
    // SocialKit returns { success, data: { downloadUrl, title, ... } }.
    // Also handles legacy flat response shapes for backward compatibility.
    logger.info('[IG DEBUG] Starting flexible media URL extraction');

    const nested = data.data && typeof data.data === 'object' ? data.data : null;

    const videoUrl =
      (nested && nested.downloadUrl) ||
      (nested && nested.video_url) ||
      (nested && nested.media_url) ||
      (nested && nested.url && !isInstagramPageUrl(nested.url) && nested.url) ||
      data.video_url ||
      data.media_url ||
      (data.url && !isInstagramPageUrl(data.url) && data.url) ||
      data.download_url ||
      data.file_url ||
      data.content_url ||
      (Array.isArray(data.urls) && data.urls[0]?.url) ||
      (Array.isArray(data.data) && data.data[0]?.url) ||
      (data.result && (data.result.video_url || data.result.download_url || data.result.url || data.result[0]?.url)) ||
      (data.result?.download?.url);

    const audioUrl =
      (nested && nested.audio_url) ||
      (nested && nested.music_url) ||
      data.audio_url ||
      data.music_url ||
      (data.result && (data.result.audio_url || data.result.music_url));

    const thumbnailUrl =
      (nested && nested.thumbnail) ||
      (nested && nested.thumbnail_url) ||
      data.thumbnail_url ||
      data.cover_url ||
      data.thumbnail ||
      (data.result && data.result.thumbnail);

    const title =
      (nested && nested.title) ||
      (nested && nested.caption) ||
      data.title ||
      data.caption ||
      (data.result && (data.result.title || data.result.caption));

    logger.info('[IG DEBUG] Extraction results:', {
      videoUrl: videoUrl ? 'found' : 'not found',
      audioUrl: audioUrl ? 'found' : 'not found',
      thumbnailUrl: thumbnailUrl ? 'found' : 'not found',
      title: title ? 'found' : 'not found'
    });

    if (!videoUrl) {
      logger.error('[IG DEBUG] No video URL found in response');
      const msg = (data.message || data.error || '').toLowerCase();
      if (
        data.status === 404 ||
        msg.includes('private') ||
        msg.includes('deleted') ||
        (msg.includes('reel') && msg.includes('not found'))
      ) {
        logger.error('[IG DEBUG] Explicit private/not found indicators - throwing PrivateOrDeletedReelError');
        throw new PrivateOrDeletedReelError();
      }
      logger.error('[IG DEBUG] No explicit private indicators - throwing InstagramApiError');
      throw new InstagramApiError('Could not find downloadable media URL in response.');
    }

    logger.info('[IG DEBUG] Instagram direct media URL received:', { shortcode, mediaUrl: videoUrl });

    return {
      id: shortcode,
      mediaUrl: videoUrl,
      audioUrl: audioUrl || undefined,
      title: title || undefined,
      thumbnailUrl: thumbnailUrl || undefined,
    };
  } catch (error: unknown) {
    logger.error('[IG DEBUG] ERROR name:', error instanceof Error ? error.constructor.name : 'Unknown');
    logger.error('[IG DEBUG] ERROR message:', error instanceof Error ? error.message : String(error));
    
    if (
      error instanceof PrivateOrDeletedReelError ||
      error instanceof InstagramApiError
    ) {
      logger.error('[IG DEBUG] Re-throwing known error type');
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.message;

      logger.error(`[IG DEBUG] Instagram API HTTP error [${status}]`, errorMsg);

      if (status === 404 || status === 403) {
        logger.error('[IG DEBUG] HTTP 404/403 - throwing PrivateOrDeletedReelError');
        throw new PrivateOrDeletedReelError();
      }

      logger.error('[IG DEBUG] HTTP error but not 404/403 - throwing InstagramApiError');
      throw new InstagramApiError(`Extraction provider returned HTTP ${status || 'error'}: ${errorMsg}`);
    }

    logger.error('[IG DEBUG] Unexpected error fetching Instagram Reel from SocialKit', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}

