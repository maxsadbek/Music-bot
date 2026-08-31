import { describe, expect, it } from 'vitest';
import {
  extractInstagramUrlFromText,
  validateAndNormalizeInstagramUrl,
} from '../lib/validation/instagram';
import { InvalidInstagramUrlError } from '../lib/utils/errors';

describe('Instagram URL Validation & Normalization', () => {
  it('should normalize standard Instagram Reel URLs', () => {
    const input = 'https://www.instagram.com/reel/Db2K5ZCIsGc/';
    const result = validateAndNormalizeInstagramUrl(input);

    expect(result.shortcode).toBe('Db2K5ZCIsGc');
    expect(result.normalizedUrl).toBe('https://www.instagram.com/reel/Db2K5ZCIsGc/');
  });

  it('should normalize Instagram Reels plural URL with query parameters', () => {
    const input = 'https://www.instagram.com/reels/Db2K5ZCIsGc/?utm_source=ig_web_copy_link';
    const result = validateAndNormalizeInstagramUrl(input);

    expect(result.shortcode).toBe('Db2K5ZCIsGc');
    expect(result.normalizedUrl).toBe('https://www.instagram.com/reel/Db2K5ZCIsGc/');
  });

  it('should normalize instagr.am /p/ post links', () => {
    const input = 'https://instagr.am/p/Db2K5ZCIsGc';
    const result = validateAndNormalizeInstagramUrl(input);

    expect(result.shortcode).toBe('Db2K5ZCIsGc');
    expect(result.normalizedUrl).toBe('https://www.instagram.com/reel/Db2K5ZCIsGc/');
  });

  it('should throw InvalidInstagramUrlError for non-Instagram links', () => {
    expect(() => validateAndNormalizeInstagramUrl('https://youtube.com/watch?v=123')).toThrow(
      InvalidInstagramUrlError
    );
  });

  it('should throw InvalidInstagramUrlError for invalid Instagram URLs', () => {
    expect(() => validateAndNormalizeInstagramUrl('https://instagram.com/accounts/login')).toThrow(
      InvalidInstagramUrlError
    );
  });

  it('should extract Instagram URL embedded inside message text', () => {
    const text = 'Check out this cool song https://www.instagram.com/reel/Db2K5ZCIsGc/ inside this post!';
    const extracted = extractInstagramUrlFromText(text);

    expect(extracted).toBe('https://www.instagram.com/reel/Db2K5ZCIsGc/');
  });

  it('should return null if no Instagram Reel URL is present in message text', () => {
    const text = 'Hello bot, please help me';
    const extracted = extractInstagramUrlFromText(text);

    expect(extracted).toBeNull();
  });
});
