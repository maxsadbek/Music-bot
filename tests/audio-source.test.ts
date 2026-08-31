import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getSongAudio, AudioSourceError } from '../lib/services/audio-source';

vi.mock('axios');

describe('Audio Source Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    vi.mocked(axios.get)
      .mockResolvedValueOnce(mockSearchResponse as never)
      .mockResolvedValueOnce({ data: mockAudioBuffer } as never);

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.durationSeconds).toBe(275);
    expect(result.buffer).toEqual(mockAudioBuffer);

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.objectContaining({ timeout: 10000 })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/high.mp3',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 20000 })
    );
  });

  it('should fall back to JioSaavn direct API when saavn.dev returns no results', async () => {
    // saavn.dev returns empty results
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: { results: [] } },
    } as never);

    // JioSaavn direct returns results
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

    vi.mocked(axios.get)
      .mockResolvedValueOnce(mockJioResponse as never)
      .mockResolvedValueOnce({ data: mockAudioBuffer } as never);

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.buffer).toEqual(mockAudioBuffer);

    // Should have called both saavn.dev and jiosaavn.com
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.anything()
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://www.jiosaavn.com/api.php',
      expect.anything()
    );
  });

  it('should throw AudioSourceError when no search results are found from any provider', async () => {
    // Both providers return empty results
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: { results: [] } },
    } as never);
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { results: [] },
    } as never);

    await expect(getSongAudio('Unknown Track', 'Unknown Artist')).rejects.toThrow(
      AudioSourceError
    );
  });

  it('should throw AudioSourceError when download returns HTML', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
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
      } as never)
      .mockResolvedValueOnce({
        data: Buffer.from('<!doctype html><html></html>'),
      } as never);

    await expect(getSongAudio('Test Song', 'Test Artist')).rejects.toThrow(
      AudioSourceError
    );
  });
});
