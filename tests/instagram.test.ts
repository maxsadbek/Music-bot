import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { getInstagramReel } from '../lib/services/instagram';
import { InstagramApiError, PrivateOrDeletedReelError } from '../lib/utils/errors';

vi.mock('axios');
const mockedAxios = axios as any;

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

  it('should send POST request with access_key in body and x-access-key header', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          downloadUrl: 'https://cdn.socialkit.dev/video.mp4',
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
        url: 'https://www.instagram.com/reel/DRU4smMj0cu/',
        access_key: 'test_socialkit_key',
        format: 'mp4',
        quality: '720p',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-access-key': 'test_socialkit_key',
        },
        timeout: 12000,
      }
    );

    expect(result.id).toBe('DRU4smMj0cu');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/video.mp4');
  });

  it('should extract media URL from nested SocialKit response with downloadUrl', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          downloadUrl: 'https://socialkit-downloads.s3.amazonaws.com/cache/reel_720p.mp4?sig=abc',
          title: 'Test Reel',
          duration: '0:27',
          thumbnail: 'https://example.com/thumb.jpg',
        },
      },
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/NESTED1/');
    expect(result.mediaUrl).toBe('https://socialkit-downloads.s3.amazonaws.com/cache/reel_720p.mp4?sig=abc');
    expect(result.title).toBe('Test Reel');
    expect(result.thumbnailUrl).toBe('https://example.com/thumb.jpg');
  });

  it('should throw PrivateOrDeletedReelError when SocialKit returns explicit private account error', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
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

  it('should throw InstagramApiError when SocialKit returns error without explicit private/deleted message', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
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
        url: 'https://www.instagram.com/reel/DZ0F3osxnh2/',
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
        url: 'https://www.instagram.com/reel/DZ0F3osxnh2/',
        download_url: 'https://cdn.socialkit.dev/direct-video.mp4',
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
        video_url: 'https://cdn.socialkit.dev/video.mp4',
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
        urls: [
          {
            url: 'https://cdn.socialkit.dev/nested-video.mp4',
          },
        ],
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
        title: 'Sample Reel',
        thumbnail: 'https://cdn.socialkit.dev/thumb.jpg',
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
        message: 'Generic error occurred',
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
        video_url: 'https://cdn.socialkit.dev/video.mp4',
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
      data: null,
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
        file_url: 'https://cdn.socialkit.dev/file-video.mp4',
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
        content_url: 'https://cdn.socialkit.dev/content-video.mp4',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/CONTENT123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/content-video.mp4');
  });

  // Test 1: direct video_url
  it('should extract media URL from direct video_url field at root level', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        video_url: 'https://cdn.socialkit.dev/direct-video.mp4',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DIRECT123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/direct-video.mp4');
  });

  // Test 2: nested data.video_url
  it('should extract media URL from nested result.video_url', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        result: {
          video_url: 'https://cdn.socialkit.dev/nested-data-video.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/NESTED123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/nested-data-video.mp4');
  });

  // Test 3: nested result.download_url
  it('should extract media URL from nested result.download_url', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        result: {
          download_url: 'https://cdn.socialkit.dev/result-download.mp4',
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/RESULT123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/result-download.mp4');
  });

  // Test 4: array-based media response
  it('should extract media URL from array-based media response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        urls: [
          {
            url: 'https://cdn.socialkit.dev/array-video.mp4',
          },
        ],
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/ARRAY123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/array-video.mp4');
  });

  // Test 5: Instagram page URL rejection
  it('should reject Instagram page URL and throw InstagramApiError when no valid alternative exists', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        url: 'https://www.instagram.com/reel/REJECT123/',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/REJECT123/')
    ).rejects.toThrow(InstagramApiError);
  });

  // Test 6: valid CDN URL without .mp4 extension
  it('should accept valid CDN URL without .mp4 extension', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        video_url: 'https://cdn.instagram.com/v/t123.45678/video_cdn/1234567890_1234567890.mp4?_nc_ht=cdn.instagram.com&_nc_cat=1',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/CDN123/');
    expect(result.mediaUrl).toBe('https://cdn.instagram.com/v/t123.45678/video_cdn/1234567890_1234567890.mp4?_nc_ht=cdn.instagram.com&_nc_cat=1');
  });

  // Test 7: explicit private response
  it('should throw PrivateOrDeletedReelError for explicit private account response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        message: 'This account is private',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/PRIVATE123/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  // Test 8: explicit deleted response
  it('should throw PrivateOrDeletedReelError for explicit deleted reel response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        message: 'This reel has been deleted',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/DELETED123/')
    ).rejects.toThrow(PrivateOrDeletedReelError);
  });

  // Test 9: HTTP 200 with unexpected response structure
  it('should throw InstagramApiError for HTTP 200 with unexpected response structure', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        unexpected_field: 'some_value',
        another_field: 123,
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/UNEXPECTED123/')
    ).rejects.toThrow(InstagramApiError);
  });

  // Test 10: HTTP error from SocialKit
  it('should throw InstagramApiError for HTTP error from SocialKit', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        status: 500,
        data: {
          message: 'Internal server error',
        },
      },
    });

    await expect(
      getInstagramReel('https://www.instagram.com/reel/HTTPERROR123/')
    ).rejects.toThrow(InstagramApiError);
  });

  // Test 11: nested result.download object with url field
  it('should extract media URL from nested result.download.url structure', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        result: {
          download: {
            url: 'https://cdn.socialkit.dev/result-download-nested.mp4',
          },
        },
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/DEEPNEST123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/result-download-nested.mp4');
  });

  // Test 12: multiple media candidates with priority
  it('should prefer video URL over download URL when both exist', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        video_url: 'https://cdn.socialkit.dev/priority-video.mp4',
        download_url: 'https://cdn.socialkit.dev/priority-download.mp4',
      },
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });

    const result = await getInstagramReel('https://www.instagram.com/reel/PRIORITY123/');
    expect(result.mediaUrl).toBe('https://cdn.socialkit.dev/priority-video.mp4');
  });
});
