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
        { field: 'audio_url', value: payload.audio_url },
        { field: 'audioUrl', value: payload.audioUrl },
        { field: 'music_url', value: payload.music_url },
        { field: 'musicUrl', value: payload.musicUrl },
        { field: 'audio', value: payload.audio },
        { field: 'mp3_url', value: payload.mp3_url },
        { field: 'mp3', value: payload.mp3 },
      ];
      for (const { field, value } of audioFields) {
        if (value) {
          logger.info(`[Instagram] candidate found: ${field} = ${value}`);
          if (isValidMediaUrl(value)) {
            audioUrl = value;
            logger.info(`[Instagram] selected: ${field}`);
            break;
          } else {
            logger.info(`[Instagram] rejected: ${field} (invalid media URL)`);
          }
        }
      }
    }

    // 2. Check video / direct media candidate fields
    if (!videoUrl) {
      const videoFields = [
        { field: 'video_url', value: payload.video_url },
        { field: 'videoUrl', value: payload.videoUrl },
        { field: 'download_url', value: payload.download_url },
        { field: 'downloadUrl', value: payload.downloadUrl },
        { field: 'direct_url', value: payload.direct_url },
        { field: 'directUrl', value: payload.directUrl },
        { field: 'media_url', value: payload.media_url },
        { field: 'mediaUrl', value: payload.mediaUrl },
        { field: 'video', value: payload.video },
        { field: 'src', value: payload.src },
        { field: 'link', value: payload.link },
        { field: 'url', value: payload.url },
        { field: 'file', value: payload.file },
        { field: 'file_url', value: payload.file_url },
        { field: 'fileUrl', value: payload.fileUrl },
        { field: 'content', value: payload.content },
        { field: 'content_url', value: payload.content_url },
        { field: 'contentUrl', value: payload.contentUrl },
      ];
      for (const { field, value } of videoFields) {
        if (value) {
          logger.info(`[Instagram] candidate found: ${field} = ${value}`);
          if (isValidMediaUrl(value)) {
            videoUrl = value;
            logger.info(`[Instagram] selected: ${field}`);
            break;
          } else {
            if (isInstagramPageUrl(value)) {
              logger.info(`[Instagram] rejected: ${field} (URL is Instagram page)`);
            } else {
              logger.info(`[Instagram] rejected: ${field} (invalid media URL)`);
            }
          }
        }
      }
    }

    // 3. Check deeply nested structures like result.download.url, data.media.url, etc.
    if (!videoUrl || !audioUrl) {
      const nestedContainers = [
        'download',
        'media',
        'video',
        'item',
        'response',
      ];
      
      for (const container of nestedContainers) {
        if (payload[container] && typeof payload[container] === 'object') {
          const nested = payload[container];
          logger.info(`[Instagram] checking nested container: ${container}`);
          
          // Check for common URL fields in nested object
          const nestedFields = [
            { field: `${container}.url`, value: nested.url },
            { field: `${container}.video_url`, value: nested.video_url },
            { field: `${container}.download_url`, value: nested.download_url },
            { field: `${container}.media_url`, value: nested.media_url },
            { field: `${container}.link`, value: nested.link },
          ];
          
          for (const { field, value } of nestedFields) {
            if (value) {
              logger.info(`[Instagram] candidate found: ${field} = ${value}`);
              if (!audioUrl && (field.includes('audio') || field.includes('music') || field.includes('mp3'))) {
                if (isValidMediaUrl(value)) {
                  audioUrl = value;
                  logger.info(`[Instagram] selected: ${field}`);
                }
              } else if (!videoUrl && isValidMediaUrl(value)) {
                videoUrl = value;
                logger.info(`[Instagram] selected: ${field}`);
                break;
              }
            }
          }
        }
      }
    }

    // 4. Check array candidate fields (urls, medias, videos, links)
    const arrayCandidates = [
      { field: 'urls', value: payload.urls },
      { field: 'medias', value: payload.medias },
      { field: 'videos', value: payload.videos },
      { field: 'links', value: payload.links },
      { field: 'root array', value: Array.isArray(payload) ? payload : null },
    ].filter(item => Array.isArray(item.value));

    for (const { field, value: arr } of arrayCandidates) {
      logger.info(`[Instagram] checking array field: ${field} (${arr.length} items)`);
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (typeof item === 'string') {
          logger.info(`[Instagram] candidate found: ${field}[${i}] = ${item}`);
          if (isValidMediaUrl(item)) {
            if (!videoUrl) {
              videoUrl = item;
              logger.info(`[Instagram] selected: ${field}[${i}]`);
            }
          } else {
            if (isInstagramPageUrl(item)) {
              logger.info(`[Instagram] rejected: ${field}[${i}] (URL is Instagram page)`);
            } else {
              logger.info(`[Instagram] rejected: ${field}[${i}] (invalid media URL)`);
            }
          }
        } else if (item && typeof item === 'object') {
          const itemAudio =
            item.audio_url || item.audioUrl || item.music_url || item.audio || item.mp3;
          const itemVideo =
            item.video_url || item.videoUrl || item.download_url || item.media_url || item.url || item.link;

          if (itemAudio) {
            logger.info(`[Instagram] candidate found: ${field}[${i}].audio_url = ${itemAudio}`);
            if (!audioUrl && isValidMediaUrl(itemAudio)) {
              audioUrl = itemAudio;
              logger.info(`[Instagram] selected: ${field}[${i}].audio_url`);
            }
          }
          if (itemVideo) {
            logger.info(`[Instagram] candidate found: ${field}[${i}].video_url = ${itemVideo}`);
            if (!videoUrl && isValidMediaUrl(itemVideo)) {
              videoUrl = itemVideo;
              logger.info(`[Instagram] selected: ${field}[${i}].video_url`);
            }
          }
        }
      }
    }

    // 5. Fallback to generic 'url' field ONLY if it is a valid direct media URL (not an Instagram page URL!)
    // (Note: url is already checked in videoFields above, this is a safety fallback for edge cases)
    if (!videoUrl && payload.url) {
      logger.info(`[Instagram] candidate found: url = ${payload.url}`);
      if (isValidMediaUrl(payload.url)) {
        videoUrl = payload.url;
        logger.info(`[Instagram] selected: url (fallback)`);
      } else {
        if (isInstagramPageUrl(payload.url)) {
          logger.info(`[Instagram] rejected: url (URL is Instagram page)`);
        } else {
          logger.info(`[Instagram] rejected: url (invalid media URL)`);
        }
      }
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

  logger.info('[Instagram] Instagram shortcode:', shortcode);
  logger.info('[Instagram] SocialKit request started');
  logger.info('[Instagram] SocialKit API URL:', apiUrl);
  logger.info('[Instagram] Normalized Instagram URL:', normalizedUrl);

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

    // Add diagnostic logging for SocialKit response structure
    logger.info('[Instagram] SocialKit HTTP status:', response.status);
    logger.info('[Instagram] Response Content-Type:', response.headers?.['content-type'] || 'undefined');
    logger.info('[Instagram] Response top-level keys:', Object.keys(data));
    
    // Log nested object keys safely
    const topLevelKeys = Object.keys(data);
    for (const key of topLevelKeys) {
      const value = data[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        logger.info(`[Instagram] nested keys in ${key}:`, Object.keys(value));
      } else if (Array.isArray(value)) {
        logger.info(`[Instagram] ${key} is an array with ${value.length} items`);
        if (value.length > 0 && typeof value[0] === 'object') {
          logger.info(`[Instagram] first item keys in ${key}:`, Object.keys(value[0]));
        }
      }
    }

    // Log provider status/message/error fields
    if (data.status) {
      logger.info('[Instagram] Provider status field:', data.status);
    }
    if (data.message) {
      logger.info('[Instagram] Provider message field:', data.message);
    }
    if (data.error) {
      logger.info('[Instagram] Provider error field:', data.error);
    }

    // Log SocialKit response structure safely without logging API keys
    logger.info('[Instagram] Full sanitized response:', sanitizeForLog(data));

    if (data.success === false || data.status === 'error') {
      const msg = data.message || data.error || 'SocialKit API returned failure status';
      logger.error('[Instagram] SocialKit API error response:', msg);

      const msgLower = String(msg).toLowerCase();
      
      // Only throw PrivateOrDeletedReelError for explicit indicators of private/deleted Reels
      const isExplicitlyPrivate = 
        msgLower.includes('this account is private') ||
        msgLower.includes('private account') ||
        msgLower.includes('this reel is private');
      
      const isExplicitlyDeleted = 
        msgLower.includes('deleted') &&
        (msgLower.includes('reel') || msgLower.includes('post'));
      
      const isExplicitlyNotFound = 
        (msgLower.includes('reel not found') || 
         msgLower.includes('post not found') ||
         msgLower.includes('page not found'));

      if (isExplicitlyPrivate || isExplicitlyDeleted || isExplicitlyNotFound) {
        logger.error('[Instagram] Explicitly private/deleted/not found - throwing PrivateOrDeletedReelError');
        throw new PrivateOrDeletedReelError();
      }
      
      logger.error('[Instagram] API error but not explicitly private/deleted - throwing InstagramApiError');
      throw new InstagramApiError(`SocialKit API error: ${msg}`);
    }

    logger.info('[Instagram] Starting media URL extraction from response');
    const { videoUrl, audioUrl } = extractMediaUrls(data);

    // Log media candidates and selected field
    logger.info('[Instagram] Media extraction results:', { 
      videoUrl: videoUrl ? 'found' : 'not found', 
      audioUrl: audioUrl ? 'found' : 'not found' 
    });

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

      // Only throw PrivateOrDeletedReelError if there's clear evidence the Reel is actually private/deleted
      const rawMsg = data.message || data.error || '';
      const msgLower = String(rawMsg).toLowerCase();
      
      // Check for explicit provider indicators that the Reel is private/deleted
      const isExplicitlyPrivate = 
        msgLower.includes('private account') ||
        msgLower.includes('this account is private') ||
        msgLower.includes('private reel');
      
      const isExplicitlyDeleted = 
        msgLower.includes('deleted') &&
        (msgLower.includes('reel') || msgLower.includes('post'));
      
      const isExplicitlyNotFound = 
        (msgLower.includes('reel not found') || 
         msgLower.includes('post not found') ||
         msgLower.includes('page not found'));

      if (isExplicitlyPrivate || isExplicitlyDeleted || isExplicitlyNotFound) {
        throw new PrivateOrDeletedReelError();
      }
      
      // Otherwise, it's a parsing/structure issue, not a private/deleted Reel
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
      
      // Only throw PrivateOrDeletedReelError for explicit indicators of private/deleted Reels
      const isExplicitlyPrivate = 
        msgLower.includes('this account is private') ||
        msgLower.includes('private account') ||
        msgLower.includes('this reel is private');
      
      const isExplicitlyDeleted = 
        msgLower.includes('deleted') &&
        (msgLower.includes('reel') || msgLower.includes('post'));
      
      const isExplicitlyNotFound = 
        (msgLower.includes('reel not found') || 
         msgLower.includes('post not found') ||
         msgLower.includes('page not found'));

      if ((status === 403 || status === 404) && (isExplicitlyPrivate || isExplicitlyDeleted || isExplicitlyNotFound)) {
        throw new PrivateOrDeletedReelError();
      }

      throw new InstagramApiError(`SocialKit API returned HTTP ${status || 'error'}: ${errorMsg}`);
    }

    logger.error('Unexpected error fetching Instagram Reel from SocialKit', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}

