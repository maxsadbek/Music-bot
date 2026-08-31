import axios from 'axios';
import { logger } from '../utils/logger';
import { validateAndNormalizeInstagramUrl } from '../validation/instagram';
import {
  InstagramApiError,
  PrivateOrDeletedReelError,
  ProviderQuotaExhaustedError,
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
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);

  const apiUrl = process.env.INSTAGRAM_API_URL;
  const apiKey = process.env.INSTAGRAM_API_KEY;

  logger.info('[IG] Instagram request started', {
    shortcode,
    instagramApiUrlConfigured: !!apiUrl,
    instagramApiKeyConfigured: !!apiKey,
  });

  if (!apiUrl) {
    throw new InstagramApiError('Instagram API endpoint is not configured. Please set INSTAGRAM_API_URL in environment.');
  }

  if (!apiKey) {
    throw new InstagramApiError('Instagram API key is not configured. Please set INSTAGRAM_API_KEY in environment.');
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-key': apiKey,
    };

    const response = await axios.post(apiUrl, {
      url: normalizedUrl,
      access_key: apiKey,
      format: 'mp4',
      quality: '720p',
    }, {
      headers,
      timeout: 12000,
    });

    logger.info('[IG] Instagram API response status:', response.status);
    logger.info('[IG] Instagram API response body:', sanitizeForLog(response.data));

    const data = response.data;

    if (!data) {
      throw new InstagramApiError('Empty response from Instagram extraction service.');
    }

    // Flexible extraction mapping to support SocialKit API responses.
    // SocialKit returns { success, data: { downloadUrl, title, ... } }.
    // Also handles legacy flat response shapes for backward compatibility.

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

    logger.info('[IG] Instagram media URLs extracted:', videoUrl ? 1 : 0);

    if (!videoUrl) {
      logger.error('[IG] No video URL found in response');
      const msg = (data.message || data.error || '').toLowerCase();
      if (
        msg.includes('private') ||
        msg.includes('deleted') ||
        msg.includes('unavailable') ||
        (msg.includes('reel') && msg.includes('not found'))
      ) {
        logger.error('[IG] Provider explicitly reports reel as private/deleted/unavailable');
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
    if (
      error instanceof PrivateOrDeletedReelError ||
      error instanceof InstagramApiError
    ) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const providerMsg = error.response?.data?.message || error.response?.data?.error || error.message;

      logger.error(`[IG] Instagram API HTTP ${status || 'unknown'}`, providerMsg);

      const lowerMsg = (providerMsg || '').toLowerCase();

      // Detect monthly quota / credit exhaustion (SocialKit returns 403 for this)
      const isQuotaError = (
        status === 403 || status === 429
      ) && (
        lowerMsg.includes('limit') ||
        lowerMsg.includes('quota') ||
        lowerMsg.includes('credit') ||
        lowerMsg.includes('exceeded') ||
        lowerMsg.includes('exhausted')
      );

      if (isQuotaError) {
        logger.error('[IG] Provider monthly quota/request limit exhausted');
        throw new ProviderQuotaExhaustedError('SocialKit', providerMsg || undefined);
      }

      // Only treat as private/deleted when the provider explicitly says so.
      if (
        lowerMsg.includes('private') ||
        lowerMsg.includes('deleted') ||
        lowerMsg.includes('unavailable') ||
        (lowerMsg.includes('reel') && lowerMsg.includes('not found'))
      ) {
        logger.error('[IG] Provider explicitly reports reel as private/deleted/unavailable');
        throw new PrivateOrDeletedReelError();
      }

      throw new InstagramApiError(`Extraction provider returned HTTP ${status || 'error'}: ${providerMsg}`);
    }

    logger.error('[IG] Unexpected error fetching Instagram Reel', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}

