import { z } from 'zod';
import { InvalidInstagramUrlError } from '../utils/errors';

/**
 * Instagram Reel URL pattern matching:
 * Matches reel, reels, p paths from instagram.com or instagr.am domains.
 */
const INSTAGRAM_REEL_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i;

export const instagramUrlSchema = z.string().transform((val, ctx) => {
  const trimmed = val.trim();
  const match = trimmed.match(INSTAGRAM_REEL_REGEX);
  
  if (!match || !match[1]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '❌ Bu Instagram Reel linki emas.',
    });
    return z.NEVER;
  }

  const shortcode = match[1];
  const normalizedUrl = `https://www.instagram.com/reel/${shortcode}/`;

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
  const result = instagramUrlSchema.safeParse(inputUrl);
  if (!result.success) {
    throw new InvalidInstagramUrlError();
  }
  return result.data;
}

/**
 * Checks if a string contains or is an Instagram Reel URL
 */
export function extractInstagramUrlFromText(text: string): string | null {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return null;
  
  const potentialUrl = urlMatch[0];
  if (INSTAGRAM_REEL_REGEX.test(potentialUrl)) {
    return potentialUrl;
  }
  return null;
}
