/**
 * Custom Error definitions and UI error mapping for Musify Bot
 */

export class AppError extends Error {
  constructor(message: string, public userMessage: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class InvalidInstagramUrlError extends AppError {
  constructor(details?: string) {
    super(
      `Invalid Instagram URL: ${details || 'format error'}`,
      '❌ Bu Instagram Reel linki emas.'
    );
    this.name = 'InvalidInstagramUrlError';
  }
}

export class PrivateOrDeletedReelError extends AppError {
  constructor() {
    super(
      'Reel is private or deleted',
      '❌ Bu Reel\'ga kirib bo‘lmadi.'
    );
    this.name = 'PrivateOrDeletedReelError';
  }
}

export class InstagramApiError extends AppError {
  constructor(details?: string) {
    super(
      `Instagram API extraction failed: ${details || 'unknown'}`,
      '⚠️ Videoni olishda xatolik yuz berdi.\nKeyinroq qayta urinib ko‘ring.'
    );
    this.name = 'InstagramApiError';
  }
}

export class MusicNotFoundError extends AppError {
  constructor() {
    super(
      'Music could not be recognized from audio track',
      '😔 Musiqani aniqlay olmadim.\n\nPossible reasons:\n• Audio juda qisqa\n• Audio sifati past\n• Original audio / unreleased audio\n• Background noise'
    );
    this.name = 'MusicNotFoundError';
  }
}

export class MusicRecognitionApiError extends AppError {
  constructor(details?: string) {
    super(
      `Music recognition API error: ${details || 'unknown'}`,
      '⚠️ Musiqa xizmatiga bog‘lanishda xatolik yuz berdi.\nKeyinroq qayta urinib ko‘ring.'
    );
    this.name = 'MusicRecognitionApiError';
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(
      'Rate limit exceeded',
      '⏳ Juda ko‘p so‘rov yuborildi.\nBiroz kutib, qayta urinib ko‘ring.'
    );
    this.name = 'RateLimitError';
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.userMessage;
  }
  return '⚠️ Kutilmagan xatolik yuz berdi. Keyinroq qayta urinib ko‘ring.';
}
