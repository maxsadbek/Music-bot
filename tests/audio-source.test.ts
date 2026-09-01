import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getSongAudio, AudioSourceError, clearAudioCache } from '../lib/services/audio-source';

vi.mock('axios');

describe('Audio Source Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAudioCache();
  });

  it('should search saavn.dev and return downloaded audio buffer', async () => {
    const mockSearchResponse = {
      data: {
        data: {
          results: [
            {
              name: 'United In Grief',
              artists: { primary: [{ name: 'Kendrick Lamar' }] },
              duration: '275',
              downloadUrl: [
                { url: 'https://cdn.example.com/low.mp3' },
                { url: 'https://cdn.example.com/high.mp3' },
              ],
            },
          ],
        },
      },
    };
    const mockAudioBuffer = Buffer.from('mock-mp3-bytes');

    vi.mocked(axios.get).mockImplementation(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('saavn.dev/api/search')) return mockSearchResponse as never;
      if (urlStr.includes('cdn.example.com')) return { data: mockAudioBuffer } as never;
      return { data: [] } as never;
    });

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.durationSeconds).toBe(275);
    expect(result.buffer.toString()).toBe('mock-mp3-bytes');
  });

  it('should fall back to JioSaavn direct API when saavn.dev returns no results', async () => {
    const mockJioResponse = {
      data: {
        results: [
          {
            song: 'United In Grief',
            singers: 'Kendrick Lamar',
            duration: '275',
            download_url: [
              { link: 'https://cdn2.example.com/low.mp3', quality: 'low' },
              { link: 'https://cdn2.example.com/high.mp3', quality: 'high' },
            ],
          },
        ],
      },
    };
    const mockAudioBuffer = Buffer.from('mock-jio-mp3-bytes');

    vi.mocked(axios.get).mockImplementation(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('jiosaavn.com/api.php')) return mockJioResponse as never;
      if (urlStr.includes('cdn2.example.com')) return { data: mockAudioBuffer } as never;
      return { data: { data: { results: [] } } } as never;
    });

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.buffer.toString()).toBe('mock-jio-mp3-bytes');
  });

  it('should throw AudioSourceError when no search results are found from any provider', async () => {
    vi.mocked(axios.get).mockImplementation(async () => ({ data: [] } as never));

    await expect(getSongAudio('Unknown Track', 'Unknown Artist')).rejects.toThrow(
      AudioSourceError
    );
  });

  it('should throw AudioSourceError when download returns HTML', async () => {
    vi.mocked(axios.get).mockImplementation(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('saavn.dev/api/search')) {
        return {
          data: {
            data: {
              results: [
                {
                  name: 'Test Song',
                  artists: { primary: [{ name: 'Test Artist' }] },
                  downloadUrl: [{ url: 'https://cdn.example.com/song.mp3' }],
                },
              ],
            },
          },
        } as never;
      }
      if (urlStr.includes('cdn.example.com')) {
        return { data: Buffer.from('<!doctype html><html></html>') } as never;
      }
      return { data: [] } as never;
    });

    await expect(getSongAudio('Test Song', 'Test Artist')).rejects.toThrow(
      AudioSourceError
    );
  });
});
