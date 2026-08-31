import { describe, expect, it } from 'vitest';
import {
  formatErrorMessage,
  InstagramApiError,
  InvalidInstagramUrlError,
  MusicNotFoundError,
  MusicRecognitionApiError,
  PrivateOrDeletedReelError,
  RateLimitError,
} from '../lib/utils/errors';

describe('Error Handling and Formatting', () => {
  it('should format InvalidInstagramUrlError correctly', () => {
    const err = new InvalidInstagramUrlError();
    expect(formatErrorMessage(err)).toBe('❌ Bu Instagram Reel linki emas.');
  });

  it('should format PrivateOrDeletedReelError correctly', () => {
    const err = new PrivateOrDeletedReelError();
    expect(formatErrorMessage(err)).toBe('❌ Bu Reel\'ga kirib bo‘lmadi.');
  });

  it('should format InstagramApiError correctly', () => {
    const err = new InstagramApiError('provider failure');
    expect(formatErrorMessage(err)).toContain('⚠️ Videoni olishda xatolik yuz berdi.');
  });

  it('should format MusicNotFoundError correctly', () => {
    const err = new MusicNotFoundError();
    expect(formatErrorMessage(err)).toContain('😔 Musiqani aniqlay olmadim.');
  });

  it('should format MusicRecognitionApiError correctly', () => {
    const err = new MusicRecognitionApiError();
    expect(formatErrorMessage(err)).toContain('⚠️ Musiqa xizmatiga bog‘lanishda xatolik yuz berdi.');
  });

  it('should format RateLimitError correctly', () => {
    const err = new RateLimitError();
    expect(formatErrorMessage(err)).toContain('⏳ Juda ko‘p so‘rov yuborildi.');
  });

  it('should format unknown generic errors gracefully', () => {
    const err = new Error('Unexpected crash');
    expect(formatErrorMessage(err)).toBe('⚠️ Kutilmagan xatolik yuz berdi. Keyinroq qayta urinib ko‘ring.');
  });
});
