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
      status: 200,
      headers: {
        'content-type': 'application/json',
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

  it('should throw PrivateOrDeletedReelError when SocialKit returns explicit private account error', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'This account is private',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  it('should throw InstagramApiError when SocialKit returns success: false error without explicit private/deleted message', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'Access key is missing',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(InstagramApiError);
  });

  it('should throw InstagramApiError (not PrivateOrDeletedReelError) for generic "not found" without reel context', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'Resource not found',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.toThrow(InstagramApiError);
    
    await expect(
      getInstagramReel('https://www.instagram.com/reel/DRU4smMj0cu/')
    ).rejects.not.toThrow(PrivateOrDeletedReelError);
  });

  it('should reject Instagram Reel page URL returned in response and throw InstagramApiError when no direct media URL exists', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          url: 'https://www.instagram.com/reel/DZ0F3osxnh2/',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
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
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DZ0F3osxnh2/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/direct-video.mp4');
  });

  it('should extract media URL from video_url field', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          video_url: 'https://cdn.socialkit.dev/video.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/TEST123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/video.mp4');
  });

  it('should extract media URL from nested media structure', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          medias: [
            {
              url: 'https://cdn.socialkit.dev/nested-video.mp4',
            },
          ],
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/TEST456/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/nested-video.mp4');
  });

  it('should throw InstagramApiError (not PrivateOrDeletedReelError) when media URL is missing without explicit private/deleted message', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          title: 'Sample Reel',
          thumbnail: 'https://cdn.socialkit.dev/thumb.jpg',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/TEST789/')
    ).rejects.toThrow(InstagramApiError);
    
    await expect(
      getInstagramReel('https://www.instagram.com/reel/TEST789/')
    ).rejects.not.toThrow(PrivateOrDeletedReelError);
  });

  it('should throw PrivateOrDeletedReelError for explicit deleted reel message', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'This reel has been deleted',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DELETED456/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  it('should throw PrivateOrDeletedReelError for explicit not found reel message', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: false,
        message: 'Reel not found',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/NOTFOUND789/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  it('should throw InstagramApiError (not PrivateOrDeletedReelError) for generic "not found" message without reel context', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          message: 'Generic error occurred',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/GENERIC123/')
    ).rejects.toThrow(InstagramApiError);
    
    await expect(
      getInstagramReel('https://www.instagram.com/reel/GENERIC123/')
    ).rejects.not.toThrow(PrivateOrDeletedReelError);
  });

  it('should handle Instagram Reel URL with query parameters', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          video_url: 'https://cdn.socialkit.dev/video.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DZ0F3osxnh2/?utm_source=ig_web_copy_link&igsh=...123');
    expect(result.id).toBe('DZ0F3osxnh2');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/video.mp4');
  });

  it('should throw InstagramApiError for malformed provider response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: null,
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/MALFORMED123/')
    ).rejects.toThrow(InstagramApiError);
  });

  it('should extract media URL from file_url field', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          file_url: 'https://cdn.socialkit.dev/file-video.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/FILE123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/file-video.mp4');
  });

  it('should extract media URL from content_url field', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          content_url: 'https://cdn.socialkit.dev/content-video.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/CONTENT123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/content-video.mp4');
  });
});
