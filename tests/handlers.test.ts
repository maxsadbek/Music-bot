import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from 'grammy';
import { formatSongCaption, handleTextMessage, sendReelVideoToTelegram } from '../lib/bot/handlers';
import * as instagramService from '../lib/services/instagram';
import * as musicService from '../lib/services/music-recognition';
import { MusicNotFoundError } from '../lib/utils/errors';

vi.mock('../lib/services/instagram');
vi.mock('../lib/services/music-recognition');

describe('Telegram Bot Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatSongCaption', () => {
    it('should format song metadata into minimal caption string with track title, artist, album, and release year', () => {
      const song = {
        title: 'United In Grief',
        artist: 'Kendrick Lamar',
        album: 'Mr. Morale & The Big Steppers',
        releaseDate: '2022-05-13',
      };

      const caption = formatSongCaption(song);

      expect(caption).toBe(
        '🎵 *United In Grief*\n' +
        '   Kendrick Lamar\n\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '💿 Mr. Morale & The Big Steppers\n' +
        '📅 2022'
      );
    });
  });

  describe('sendReelVideoToTelegram', () => {
    it('should send video directly by URL with caption and inline keyboard when Telegram API succeeds', async () => {
      const mockCtx = {
        chat: { id: 12345 },
        api: {
          sendVideo: vi.fn().mockResolvedValueOnce({ message_id: 1 }),
        },
      } as unknown as Context;

      const success = await sendReelVideoToTelegram(
        mockCtx,
        'https://cdn.socialkit.dev/video.mp4',
        'DRU4smMj0cu',
        'Test Caption'
      );

      expect(success).toBe(true);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4',
        expect.objectContaining({ caption: 'Test Caption', parse_mode: 'Markdown' })
      );
    });

    it('should fall back to Buffer upload via InputFile when direct URL send fails', async () => {
      const mockCtx = {
        chat: { id: 12345 },
        api: {
          sendVideo: vi
            .fn()
            .mockRejectedValueOnce(new Error('Telegram failed URL fetch'))
            .mockResolvedValueOnce({ message_id: 2 }),
        },
      } as unknown as Context;

      const mockBuffer = Buffer.from('mock video bytes');
      vi.spyOn(musicService, 'downloadMediaBuffer').mockResolvedValueOnce(mockBuffer);

      const success = await sendReelVideoToTelegram(
        mockCtx,
        'https://cdn.socialkit.dev/video.mp4',
        'DRU4smMj0cu',
        'Test Caption'
      );

      expect(success).toBe(true);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleTextMessage', () => {
    it('should process Instagram Reel URL, recognize song, and send ONE video message with caption and button', async () => {
      const mockCtx = {
        from: { id: 999 },
        message: { text: 'https://www.instagram.com/reel/DRU4smMj0cu/' },
        chat: { id: 12345 },
        reply: vi.fn().mockResolvedValue({ message_id: 100 }),
        api: {
          sendVideo: vi.fn().mockResolvedValue({ message_id: 101 }),
          deleteMessage: vi.fn().mockResolvedValue(true),
        },
      } as unknown as Context;

      const mockMedia = {
        id: 'DRU4smMj0cu',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
      };
      vi.spyOn(instagramService, 'getInstagramReel').mockResolvedValueOnce(mockMedia);

      const mockBuffer = Buffer.from('mock video bytes');
      vi.spyOn(musicService, 'downloadMediaBuffer').mockResolvedValueOnce(mockBuffer);

      const mockSong = {
        artist: 'Kendrick Lamar',
        title: 'United In Grief',
        album: 'Mr. Morale & The Big Steppers',
        releaseDate: '2022-05-13',
      };
      vi.spyOn(musicService, 'identifySong').mockResolvedValueOnce(mockSong);

      await handleTextMessage(mockCtx);

      expect(mockCtx.reply).toHaveBeenCalledWith('⏳ Video va musiqa yuklanmoqda...');

      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4',
        expect.objectContaining({
          caption: expect.stringContaining('United In Grief'),
          parse_mode: 'Markdown',
        })
      );

      expect(mockCtx.api.deleteMessage).toHaveBeenCalledWith(12345, 100);
    });

    it('should send video with fallback caption when music recognition finds no match', async () => {
      const mockCtx = {
        from: { id: 999 },
        message: { text: 'https://www.instagram.com/reel/DRU4smMj0cu/' },
        chat: { id: 12345 },
        reply: vi.fn().mockResolvedValue({ message_id: 100 }),
        api: {
          sendVideo: vi.fn().mockResolvedValue({ message_id: 101 }),
          deleteMessage: vi.fn().mockResolvedValue(true),
        },
      } as unknown as Context;

      const mockMedia = {
        id: 'DRU4smMj0cu',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
      };
      vi.spyOn(instagramService, 'getInstagramReel').mockResolvedValueOnce(mockMedia);
      vi.spyOn(musicService, 'downloadMediaBuffer').mockResolvedValueOnce(Buffer.from('video bytes'));
      vi.spyOn(musicService, 'identifySong').mockRejectedValueOnce(new MusicNotFoundError());

      await handleTextMessage(mockCtx);

      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4',
        expect.objectContaining({
          caption: '🎵 Musiqa aniqlanmadi.',
        })
      );
    });
  });
});
