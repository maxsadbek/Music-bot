import { z } from 'zod';
import { InvalidInstagramUrlError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Instagram Reel URL pattern matching:
 * Matches reel, reels, p paths from instagram.com or instagr.am domains.
 */
const INSTAGRAM_REEL_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i;

export const instagramUrlSchema = z.string().transform((val, ctx) => {
  const trimmed = val.trim();
  logger.info('[IG DEBUG] URL received:', trimmed);
  
  const match = trimmed.match(INSTAGRAM_REEL_REGEX);
  
  if (!match || !match[1]) {
    logger.error('[IG DEBUG] URL validation failed - does not match Instagram Reel pattern');
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '❌ Bu Instagram Reel linki emas.',
    });
    return z.NEVER;
  }

  const shortcode = match[1];
  const normalizedUrl = `https://www.instagram.com/reel/${shortcode}/`;
  
  logger.info('[IG DEBUG] shortcode extracted:', shortcode);
  logger.info('[IG DEBUG] normalized URL:', normalizedUrl);

  return {
    shortcode,
    normalizedUrl,
    rawUrl: trimmed,
  };
});

export type ValidatedInstagramUrl = z.infer<typeof instagramUrlSchema>;

/**
 * Helper to extract Instagram shortcode and normalized URL
 */
export function validateAndNormalizeInstagramUrl(inputUrl: string): ValidatedInstagramUrl {
  logger.info('[IG DEBUG] validateAndNormalizeInstagramUrl called with:', inputUrl);
  const result = instagramUrlSchema.safeParse(inputUrl);
  if (!result.success) {
    logger.error('[IG DEBUG] validateAndNormalizeInstagramUrl failed');
    throw new InvalidInstagramUrlError();
  }
  logger.info('[IG DEBUG] validateAndNormalizeInstagramUrl succeeded');
  return result.data;
}

/**
 * Checks if a string contains or is an Instagram Reel URL
 */
export function extractInstagramUrlFromText(text: string): string | null {
  logger.info('[IG DEBUG] extractInstagramUrlFromText called with text length:', text.length);
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) {
    logger.info('[IG DEBUG] No URL found in text');
    return null;
  }
  
  const potentialUrl = urlMatch[0];
  logger.info('[IG DEBUG] Potential URL found:', potentialUrl);
  
  if (INSTAGRAM_REEL_REGEX.test(potentialUrl)) {
    logger.info('[IG DEBUG] URL matches Instagram Reel pattern');
    return potentialUrl;
  }
  logger.info('[IG DEBUG] URL does not match Instagram Reel pattern');
  return null;
}
