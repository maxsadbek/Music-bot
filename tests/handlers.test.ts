import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from 'grammy';
import {
  formatReleaseDate,
  formatSongCaption,
  handleTextMessage,
  handleCallbackQuery,
  sendReelVideoToTelegram,
} from '../lib/bot/handlers';
import * as instagramService from '../lib/services/instagram';
import * as musicService from '../lib/services/music-recognition';
import * as audioSource from '../lib/services/audio-source';
import * as cacheService from '../lib/services/cache';
import { MusicNotFoundError } from '../lib/utils/errors';

vi.mock('../lib/services/instagram');
vi.mock('../lib/services/music-recognition');
vi.mock('../lib/services/audio-source');

describe('Telegram Bot Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatReleaseDate', () => {
    it('should format YYYY-MM-DD to "DD Month YYYY"', () => {
      expect(formatReleaseDate('2022-05-13')).toBe('13 May 2022');
    });

    it('should format YYYY-MM to "Month YYYY"', () => {
      expect(formatReleaseDate('2022-05')).toBe('May 2022');
    });

    it('should return just year when only year is available', () => {
      expect(formatReleaseDate('2022')).toBe('2022');
    });

    it('should handle January correctly', () => {
      expect(formatReleaseDate('2020-01-05')).toBe('5 January 2020');
    });

    it('should handle December correctly', () => {
      expect(formatReleaseDate('2023-12-25')).toBe('25 December 2023');
    });

    it('should format ACRCloud YYYYMMDD dates to "DD Month YYYY"', () => {
      expect(formatReleaseDate('20220513')).toBe('13 May 2022');
    });
  });

  describe('formatSongCaption', () => {
    it('should format song into "🎵 track - artist" with album and full date', () => {
      const song = {
        title: 'United In Grief',
        artist: 'Kendrick Lamar',
        album: 'Mr. Morale & The Big Steppers',
        releaseDate: '2022-05-13',
      };

      const caption = formatSongCaption(song);

      expect(caption).toContain('United In Grief');
      expect(caption).toContain('Kendrick Lamar');
      expect(caption).toContain('Mr. Morale & The Big Steppers');
      expect(caption).toContain('13 May 2022');
      // Must NOT truncate to just year
      expect(caption).not.toMatch(/📅 2022$/m);
    });

    it('should work without album or release date', () => {
      const song = {
        title: 'Test Track',
        artist: 'Test Artist',
      };

      const caption = formatSongCaption(song);

      expect(caption).toContain('Test Track');
      expect(caption).toContain('Test Artist');
      expect(caption).not.toContain('💿');
      expect(caption).not.toContain('📅');
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
      vi.spyOn(cacheService, 'getCachedJobByShortcode').mockResolvedValue(null);
      vi.spyOn(cacheService, 'cacheJobByShortcode').mockResolvedValue(undefined);
      vi.spyOn(cacheService, 'saveReelJob').mockResolvedValue('mock-job-id');

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

      // Status message sent with new format
      expect(mockCtx.reply).toHaveBeenCalledWith('🎬 Reel qabul qilindi\n⏳ Video olinmoqda...');

      // ONE sendVideo call with caption containing full date
      expect(mockCtx.api.sendVideo).toHaveBeenCalledTimes(1);
      const sendVideoCall = mockCtx.api.sendVideo.mock.calls[0];
      expect(sendVideoCall[0]).toBe(12345);
      expect(sendVideoCall[1]).toBe('https://cdn.socialkit.dev/video.mp4');
      const options = sendVideoCall[2];
      expect(options.caption).toContain('13 May 2022');
      expect(options.parse_mode).toBe('Markdown');
      // reply_markup is an InlineKeyboard instance
      const keyboard = options.reply_markup;
      expect(keyboard.inline_keyboard).toBeDefined();
      expect(keyboard.inline_keyboard[0][0].text).toBe('🎧 QO\u2018SHIQNI OLISH');
      expect(keyboard.inline_keyboard[0][0].callback_data).toMatch(/^get_song:[a-f0-9]+$/);

      // Status message cleaned up
      expect(mockCtx.api.deleteMessage).toHaveBeenCalledWith(12345, 100);
    });

    it('should send video with fallback caption when music recognition finds no match', async () => {
      vi.spyOn(cacheService, 'getCachedJobByShortcode').mockResolvedValue(null);
      vi.spyOn(cacheService, 'cacheJobByShortcode').mockResolvedValue(undefined);
      vi.spyOn(cacheService, 'saveReelJob').mockResolvedValue('mock-job-id');

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

      expect(mockCtx.api.sendVideo).toHaveBeenCalledTimes(1);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4',
        expect.objectContaining({
          caption: '🎵 Musiqa aniqlanmadi.',
        })
      );
    });

    it('should reuse existing recognition when same shortcode is sent again', async () => {
      const existingJob = {
        jobId: 'existing123',
        reelUrl: 'https://www.instagram.com/reel/DRU4smMj0cu/',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
        shortcode: 'DRU4smMj0cu',
        createdAt: Date.now(),
        songTitle: 'United In Grief',
        songArtist: 'Kendrick Lamar',
        songAlbum: 'Mr. Morale & The Big Steppers',
        songReleaseDate: '2022-05-13',
      };
      vi.spyOn(cacheService, 'getCachedJobByShortcode').mockResolvedValueOnce(existingJob);

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

      await handleTextMessage(mockCtx);

      // Should NOT call Instagram or ACRCloud
      expect(instagramService.getInstagramReel).not.toHaveBeenCalled();
      expect(musicService.identifySong).not.toHaveBeenCalled();

      // Should send video with existing recognition
      expect(mockCtx.api.sendVideo).toHaveBeenCalledTimes(1);
      expect(mockCtx.api.sendVideo).toHaveBeenCalledWith(
        12345,
        'https://cdn.socialkit.dev/video.mp4',
        expect.objectContaining({
          caption: expect.stringContaining('United In Grief'),
        })
      );
    });
  });

  describe('handleCallbackQuery - get_song', () => {
    it('should fetch audio and send it to the user when get_song button is pressed', async () => {
      const mockJob = {
        jobId: 'abc123',
        reelUrl: 'https://www.instagram.com/reel/DRU4smMj0cu/',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
        shortcode: 'DRU4smMj0cu',
        createdAt: Date.now(),
        songTitle: 'United In Grief',
        songArtist: 'Kendrick Lamar',
        userId: 999,
      };
      vi.spyOn(cacheService, 'getReelJob').mockResolvedValueOnce(mockJob);

      const mockAudio = {
        buffer: Buffer.from('mock audio data'),
        title: 'United In Grief',
        artist: 'Kendrick Lamar',
        durationSeconds: 240,
      };
      vi.spyOn(audioSource, 'getSongAudio').mockResolvedValueOnce(mockAudio);

      const mockCtx = {
        from: { id: 999 },
        callbackQuery: {
          data: 'get_song:abc123',
          message: { chat: { id: 12345 }, message_id: 200 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 201 }),
          sendAudio: vi.fn().mockResolvedValue({ message_id: 202 }),
        },
      } as unknown as Context;

      await handleCallbackQuery(mockCtx);

      expect(mockCtx.answerCallbackQuery).toHaveBeenCalled();
      expect(audioSource.getSongAudio).toHaveBeenCalledWith('United In Grief', 'Kendrick Lamar');
      expect(mockCtx.api.sendAudio).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({
          title: 'United In Grief',
          performer: 'Kendrick Lamar',
          duration: 240,
        })
      );
    });

    it('should send error message when job is not found in cache', async () => {
      vi.spyOn(cacheService, 'getReelJob').mockResolvedValueOnce(null);

      const mockCtx = {
        from: { id: 999 },
        callbackQuery: {
          data: 'get_song:missing123',
          message: { chat: { id: 12345 }, message_id: 200 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 201 }),
        },
      } as unknown as Context;

      await handleCallbackQuery(mockCtx);

      expect(mockCtx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('topilmadi')
      );
    });

    it('should reject callback from unauthorized user', async () => {
      const mockJob = {
        jobId: 'abc123',
        reelUrl: 'https://www.instagram.com/reel/DRU4smMj0cu/',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
        shortcode: 'DRU4smMj0cu',
        createdAt: Date.now(),
        songTitle: 'United In Grief',
        songArtist: 'Kendrick Lamar',
        userId: 999, // Original user
      };
      vi.spyOn(cacheService, 'getReelJob').mockResolvedValueOnce(mockJob);

      const mockCtx = {
        from: { id: 1111 }, // Different user trying to access
        callbackQuery: {
          data: 'get_song:abc123',
          message: { chat: { id: 12345 }, message_id: 200 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 201 }),
        },
      } as unknown as Context;

      await handleCallbackQuery(mockCtx);

      expect(mockCtx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('so\'rovngiz emas')
      );
      // Should NOT attempt to download audio
      expect(audioSource.getSongAudio).not.toHaveBeenCalled();
    });

    it('should allow callback when job has no userId set (backward compatibility)', async () => {
      const mockJob = {
        jobId: 'abc123',
        reelUrl: 'https://www.instagram.com/reel/DRU4smMj0cu/',
        mediaUrl: 'https://cdn.socialkit.dev/video.mp4',
        shortcode: 'DRU4smMj0cu',
        createdAt: Date.now(),
        songTitle: 'Test Song',
        songArtist: 'Test Artist',
        // No userId set (old job format)
      };
      vi.spyOn(cacheService, 'getReelJob').mockResolvedValueOnce(mockJob);

      const mockAudio = {
        buffer: Buffer.from('mock audio data'),
        title: 'Test Song',
        artist: 'Test Artist',
        durationSeconds: 180,
      };
      vi.spyOn(audioSource, 'getSongAudio').mockResolvedValueOnce(mockAudio);

      const mockCtx = {
        from: { id: 1111 },
        callbackQuery: {
          data: 'get_song:abc123',
          message: { chat: { id: 12345 }, message_id: 200 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 201 }),
          sendAudio: vi.fn().mockResolvedValue({ message_id: 202 }),
        },
      } as unknown as Context;

      await handleCallbackQuery(mockCtx);

      // Should proceed with audio download (no userId to check against)
      expect(audioSource.getSongAudio).toHaveBeenCalledWith('Test Song', 'Test Artist');
      expect(mockCtx.api.sendAudio).toHaveBeenCalled();
    });
  });
});
