import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from 'grammy';
import { handleTextMessage, sendReelVideoToTelegram } from '../lib/bot/handlers';
import * as instagramService from '../lib/services/instagram';
import * as musicService from '../lib/services/music-recognition';

vi.mock('../lib/services/instagram');
vi.mock('../lib/services/music-recognition');

describe('Telegram Bot Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendReelVideoToTelegram', () => {
    it('should send video directly by URL when Telegram API succeeds', async () => {
      const mockCtx = {
        chat: { id: 12345 },
        api: {
          sendVideo: vi.fn().mockResolvedValueOnce({ message_id: 1 }),
        },
      } as unknown as Context;

      const success = await sendReelVideoToTelegram(
        mockCtx,
        'https://cdn.socialkit.dev/video.mp4',
        'DRU4smMj0cu'
      );

      expect(success).toBe(true);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4'
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
        'DRU4smMj0cu'
      );

      expect(success).toBe(true);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleTextMessage', () => {
    it('should process Instagram Reel URL, send video, and output music recognition result', async () => {
      const mockCtx = {
        from: { id: 999 },
        message: { text: 'https://www.instagram.com/reel/DRU4smMj0cu/' },
        chat: { id: 12345 },
        reply: vi.fn().mockResolvedValue({ message_id: 100 }),
        api: {
          sendVideo: vi.fn().mockResolvedValue({ message_id: 101 }),
          editMessageText: vi.fn().mockResolvedValue({ message_id: 100 }),
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

      expect(mockCtx.reply).toHaveBeenCalledWith(
        '🎬 Reel qabul qilindi\n\n⏳ Video olinmoqda...'
      );

      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4'
      );

      expect(mockCtx.api.editMessageText).toHaveBeenCalledWith(
        12345,
        100,
        expect.stringContaining('Kendrick Lamar'),
        expect.objectContaining({ parse_mode: 'Markdown' })
      );
    });
  });
});
