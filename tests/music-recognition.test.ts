import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { identifySong } from '../lib/services/music-recognition';
import { MusicNotFoundError, MusicRecognitionApiError } from '../lib/utils/errors';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('ACRCloud Music Recognition Service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ACRCLOUD_HOST = 'identify-eu-west-1.acrcloud.com';
    process.env.ACRCLOUD_ACCESS_KEY = 'test_access_key';
    process.env.ACRCLOUD_ACCESS_SECRET = 'test_access_secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw MusicRecognitionApiError when ACRCloud credentials are missing', async () => {
    delete process.env.ACRCLOUD_ACCESS_KEY;

    await expect(
      identifySong('https://cdn.example.com/audio.mp3')
    ).rejects.toThrow(MusicRecognitionApiError);
  });

  it('should successfully identify song from ACRCloud API response', async () => {
    // 1. Mock audio file download
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('mock audio content buffer data'),
    });

    // 2. Mock ACRCloud identify API response
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: {
          code: 0,
          msg: 'Success',
        },
        metadata: {
          music: [
            {
              title: 'Blinding Lights',
              artists: [{ name: 'The Weeknd' }],
              album: { name: 'After Hours' },
              release_date: '2020-03-20',
              external_metadata: {
                spotify: {
                  track: { id: '0VjIjW4GlUZAMYd2vXMi3b' },
                },
              },
            },
          ],
        },
      },
    });

    const result = await identifySong('https://cdn.example.com/audio.mp3');

    expect(result.title).toBe('Blinding Lights');
    expect(result.artist).toBe('The Weeknd');
    expect(result.album).toBe('After Hours');
    expect(result.releaseDate).toBe('2020-03-20');
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
  });

  it('should throw MusicNotFoundError when ACRCloud returns code 1001 (No match)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('mock audio content'),
    });

    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: {
          code: 1001,
          msg: 'No result',
        },
      },
    });

    await expect(
      identifySong('https://cdn.example.com/audio.mp3')
    ).rejects.toThrow(MusicNotFoundError);
  });

  it('should throw MusicRecognitionApiError when media URL returns text/html content-type', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('<!DOCTYPE html><html><body>Page</body></html>'),
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    await expect(
      identifySong('https://www.instagram.com/reel/DZ0F3osxnh2/')
    ).rejects.toThrow(MusicRecognitionApiError);
  });

  it('should throw MusicRecognitionApiError when media URL returns HTML body bytes despite non-HTML header', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('<!DOCTYPE html><html><head><title>Instagram</title></head></html>'),
      headers: { 'content-type': 'application/octet-stream' },
    });

    await expect(
      identifySong('https://cdn.example.com/page.html')
    ).rejects.toThrow(MusicRecognitionApiError);
  });
});
