import { InlineKeyboard } from 'grammy';
import { SongResult } from '../services/music-recognition';

/**
 * Creates inline keyboard with [ 🎧 QO‘SHIQNI OLISH ] button below video
 */
export function buildGetSongKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('🎧 QO‘SHIQNI OLISH', `get_song:${jobId}`);
}

/**
 * Creates keyboard for initial reel processed state
 */
export function buildFindMusicKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('🎵 Musiqani topish', `find_music:${jobId}`);
}

/**
 * Creates keyboard with streaming links (Spotify, Apple Music)
 * Only displays buttons for links that actually exist.
 */
export function buildSongLinksKeyboard(song: SongResult): InlineKeyboard | undefined {
  const keyboard = new InlineKeyboard();
  let addedAny = false;

  if (song.spotifyUrl) {
    keyboard.url('🎧 Spotify', song.spotifyUrl);
    addedAny = true;
  }

  if (song.appleMusicUrl) {
    if (addedAny) {
      keyboard.row();
    }
    keyboard.url('🍎 Apple Music', song.appleMusicUrl);
    addedAny = true;
  }

  return addedAny ? keyboard : undefined;
}

/**
 * Creates keyboard for retry action
 */
export function buildRetryKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard().text('🔄 Qayta urinib ko‘rish', `retry_music:${jobId}`);
}
