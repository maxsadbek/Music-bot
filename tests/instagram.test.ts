import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getInstagramReel, cleanupTempFile, isInstagramPageUrl, isValidMediaUrl, sanitizeForLog } from '../lib/services/instagram';
import { InstagramApiError, PrivateOrDeletedReelError } from '../lib/utils/errors';

vi.mock('axios');
vi.mock('fs');
vi.mock('os');

const mockedAxios = vi.mocked(axios, true);
const mockedFs = vi.mocked(fs, true);
const mockedOs = vi.mocked(os, true);

describe('Render Downloader Instagram Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RENDER_DOWNLOADER_URL = 'https://musify-downloader.onrender.com';
    vi.resetAllMocks();
    mockedOs.tmpdir.mockReturnValue('/tmp');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue(Buffer.from('mock video bytes'));
    (mockedAxios as any).isAxiosError = (obj: any) =>
      obj != null && typeof obj === 'object' && 'response' in obj;
  });

  afterEach(() => { process.env = originalEnv; });

  describe('isInstagramPageUrl', () => {
    it('should return true for Instagram reel URLs', () => {
      expect(isInstagramPageUrl('https://www.instagram.com/reel/ABC123/')).toBe(true);
    });
    it('should return true for Instagram post URLs', () => {
      expect(isInstagramPageUrl('https://www.instagram.com/p/ABC123/')).toBe(true);
    });
    it('should return false for non-Instagram URLs', () => {
      expect(isInstagramPageUrl('https://example.com/video.mp4')).toBe(false);
    });
    it('should return false for invalid URLs', () => {
      expect(isInstagramPageUrl('not-a-url')).toBe(false);
    });
  });

  describe('isValidMediaUrl', () => {
    it('should return true for valid CDN URLs', () => {
      expect(isValidMediaUrl('https://cdn.example.com/video.mp4')).toBe(true);
    });
    it('should return false for Instagram page URLs', () => {
      expect(isValidMediaUrl('https://www.instagram.com/reel/ABC123/')).toBe(false);
    });
    it('should return false for non-string input', () => {
      expect(isValidMediaUrl(null)).toBe(false);
    });
  });

  describe('sanitizeForLog', () => {
    it('should redact keys and tokens', () => {
      const result = sanitizeForLog({
        access_token: 'super-secret-token-12345',
        name: 'visible',
      }) as Record<string, unknown>;
      expect(result.access_token).toBe('[REDACTED]');
      expect(result.name).toBe('visible');
    });
    it('should handle nested objects', () => {
      const result = sanitizeForLog({
        data: { api_key: 'secret-key', value: 'visible' },
      }) as Record<string, unknown>;
      const data = result.data as Record<string, unknown>;
      expect(data.api_key).toBe('[REDACTED]');
      expect(data.value).toBe('visible');
    });
    it('should handle null and undefined', () => {
      expect(sanitizeForLog(null)).toBeNull();
      expect(sanitizeForLog(undefined)).toBeUndefined();
    });
  });

  describe('getInstagramReel', () => {
    it('should complete full flow: /api/jobs → poll → file download', async () => {
      // Mock /api/jobs (no /api/info anymore)
      mockedAxios.post.mockResolvedValueOnce({
        data: { jobId: 'job_abc123', status: 'pending' },
        status: 200,
      });

      // Mock poll + file download
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { status: 'processing', jobId: 'job_abc123' },
          status: 200,
        })
        .mockResolvedValueOnce({
          data: { status: 'completed', fileUrl: 'https://cdn.render.com/video.mp4' },
          status: 200,
        })
        .mockResolvedValueOnce({
          data: Buffer.from('video-content'),
          status: 200,
        });

      const result = await getInstagramReel('https://www.instagram.com/reel/TEST123/');

      // Verify /api/jobs was called (NOT /api/info)
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://musify-downloader.onrender.com/api/jobs',
        { url: 'https://www.instagram.com/reel/TEST123/', format: 'mp4', quality: '720p' },
        { timeout: 8_000 }
      );

      expect(result.id).toBe('TEST123');
      expect(result.mediaUrl).toBe('https://cdn.render.com/video.mp4');
      expect(result.videoFilePath).toBeDefined();
    });

    it('should handle direct file URL from /api/jobs without job ID', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { video_url: 'https://cdn.render.com/direct-video.mp4' },
        status: 200,
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: Buffer.from('direct-video-content'),
        status: 200,
      });

      const result = await getInstagramReel('https://www.instagram.com/reel/QUICK1/');

      expect(result.mediaUrl).toBe('https://cdn.render.com/direct-video.mp4');
      expect(result.videoFilePath).toBeDefined();
    });

    it('should throw PrivateOrDeletedReelError when /api/jobs reports private reel', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: 'This account is private' },
        status: 200,
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/PRIVATE1/')
      ).rejects.toThrow(PrivateOrDeletedReelError);
    });

    it('should throw PrivateOrDeletedReelError when /api/jobs reports deleted reel', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { message: 'Reel not found' },
        status: 200,
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/DELETED1/')
      ).rejects.toThrow(PrivateOrDeletedReelError);
    });

    it('should throw InstagramApiError when /api/jobs returns empty response', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: null,
        status: 200,
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/EMPTY1/')
      ).rejects.toThrow(InstagramApiError);
    });

    it('should throw InstagramApiError when /api/jobs returns no job ID or URL', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { status: 'ok' },
        status: 200,
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/NOJOB1/')
      ).rejects.toThrow(InstagramApiError);
    });

    it('should throw InstagramApiError when job fails during polling', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { jobId: 'job_fail1' },
        status: 200,
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: { status: 'failed', error: 'Download failed' },
        status: 200,
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/FAIL1/')
      ).rejects.toThrow(InstagramApiError);
    });

    it('should throw InstagramApiError on HTTP error from downloader', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { message: 'Internal server error' },
        },
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/HTTPERR/')
      ).rejects.toThrow(InstagramApiError);
    });

    it('should throw PrivateOrDeletedReelError for HTTP error with private/deleted message', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { message: 'This reel has been deleted' },
        },
      });

      await expect(
        getInstagramReel('https://www.instagram.com/reel/DELHTTP/')
      ).rejects.toThrow(PrivateOrDeletedReelError);
    });

    it('should handle Instagram Reel URL with query parameters', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { jobId: 'job_params1' },
        status: 200,
      });

      mockedAxios.get
        .mockResolvedValueOnce({
          data: { status: 'completed', fileUrl: 'https://cdn.render.com/video.mp4' },
          status: 200,
        })
        .mockResolvedValueOnce({
          data: Buffer.from('video-content'),
          status: 200,
        });

      const result = await getInstagramReel(
        'https://www.instagram.com/reel/DZ0F3osxnh2/?utm_source=ig_web_copy_link'
      );

      expect(result.id).toBe('DZ0F3osxnh2');
      expect(result.mediaUrl).toBe('https://cdn.render.com/video.mp4');
    });
  });

  describe('cleanupTempFile', () => {
    it('should delete existing file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.unlinkSync.mockReturnValue(undefined);
      cleanupTempFile('/tmp/test.mp4');
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/tmp/test.mp4');
    });

    it('should handle non-existent file gracefully', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(() => cleanupTempFile('/tmp/nonexistent.mp4')).not.toThrow();
    });

    it('should handle undefined path', () => {
      expect(() => cleanupTempFile(undefined)).not.toThrow();
    });
  });
});
