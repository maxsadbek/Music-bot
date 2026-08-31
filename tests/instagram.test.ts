import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { getInstagramReel } from '../lib/services/instagram';
import { InstagramApiError, PrivateOrDeletedReelError } from '../lib/utils/errors';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('SocialKit Instagram Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.INSTAGRAM_API_URL = 'https://api.socialkit.dev/instagram/download';
    process.env.INSTAGRAM_API_KEY = 'test_socialkit_key';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw InstagramApiError when INSTAGRAM_API_KEY is missing', async () => {
    delete process.env.INSTAGRAM_API_KEY;

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(InstagramApiError);
  });

  it('should send POST request with access_key, url, format in body and Content-Type header', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          url: 'https://cdn.socialkit.dev/video.mp4',
          audio_url: 'https://cdn.socialkit.dev/audio.mp3',
          title: 'Sample Reel',
        },
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.socialkit.dev/instagram/download',
      {
        access_key: 'test_socialkit_key',
        url: 'https://www.instagram.com/reel/DRU4smMj0cu/',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    expect(result.id).toBe('DRU4smMj0cu');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/video.mp4');
    expect(result.audioUrl).toBe('https://cdn.socialkit.dev/audio.mp3');
  });

  it('should throw PrivateOrDeletedReelError when SocialKit returns private error', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'This post is private or not found',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  it('should throw InstagramApiError when SocialKit returns success: false error', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'Access key is missing',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(InstagramApiError);
  });

  it('should reject Instagram Reel page URL returned in response and throw InstagramApiError when no direct media URL exists', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          url: 'https://www.instagram.com/reel/DZ0F3osxnh2/',
        },
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DZ0F3osxnh2/')
    ).rejects.toThrow(InstagramApiError);
  });

  it('should extract direct media URL when download_url is provided alongside Instagram page URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          url: 'https://www.instagram.com/reel/DZ0F3osxnh2/',
          download_url: 'https://cdn.socialkit.dev/direct-video.mp4',
        },
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DZ0F3osxnh2/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/direct-video.mp4');
  });
});
