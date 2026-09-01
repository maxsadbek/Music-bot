import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getSongAudio, AudioSourceError } from '../lib/services/audio-source';

vi.mock('axios');

/** Number of Invidious instances to mock (must match INVIDIOUS_INSTANCES length in audio-source.ts). */
const INSTANCE_COUNT = 8;

/** Creates an empty mock response for Invidious search. */
const invidiousEmpty = { data: [] };

describe('Audio Source Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should search saavn.dev and return downloaded audio buffer', async () => {
    // Invidious returns empty/no results (all instances)
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

    // saavn.dev returns results
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
      .mockResolvedValueOnce(mockSearchResponse as never) // saavn.dev search
      .mockResolvedValueOnce({ data: mockAudioBuffer } as never); // saavn.dev download

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.durationSeconds).toBe(275);
    expect(result.buffer).toEqual(mockAudioBuffer);

    // INSTANCE_COUNT invidious + 1 saavn search + 1 saavn download
    const expectedCalls = INSTANCE_COUNT + 2;
    expect(axios.get).toHaveBeenCalledTimes(expectedCalls);
    expect(axios.get).toHaveBeenNthCalledWith(
      INSTANCE_COUNT + 1,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.objectContaining({ timeout: 10000 })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      INSTANCE_COUNT + 2,
      'https://cdn.example.com/high.mp3',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 20000 })
    );
  });

  it('should fall back to JioSaavn direct API when saavn.dev returns no results', async () => {
    // Invidious returns empty/no results (all instances)
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

    // saavn.dev returns empty results
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { results: [] } } } as never);

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
      .mockResolvedValueOnce(mockJioResponse as never) // jiosaavn search
      .mockResolvedValueOnce({ data: mockAudioBuffer } as never); // jiosaavn download

    const result = await getSongAudio('United In Grief', 'Kendrick Lamar');

    expect(result.title).toBe('United In Grief');
    expect(result.artist).toBe('Kendrick Lamar');
    expect(result.buffer).toEqual(mockAudioBuffer);

    // INSTANCE_COUNT invidious + 1 saavn + 1 jiosaavn search + 1 jiosaavn download
    const expectedCalls = INSTANCE_COUNT + 3;
    expect(axios.get).toHaveBeenCalledTimes(expectedCalls);
    expect(axios.get).toHaveBeenNthCalledWith(
      INSTANCE_COUNT + 1,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.anything()
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      INSTANCE_COUNT + 2,
      'https://www.jiosaavn.com/api.php',
      expect.anything()
    );
  });

  it('should throw AudioSourceError when no search results are found from any provider', async () => {
    // All providers return empty results
    vi.mocked(axios.get)
      .mockResolvedValue({ data: [] } as never); // Invidious instances
    vi.mocked(axios.get)
      .mockResolvedValue({ data: { data: { results: [] } } } as never); // saavn
    vi.mocked(axios.get)
      .mockResolvedValue({ data: { results: [] } } as never); // jiosaavn

    await expect(getSongAudio('Unknown Track', 'Unknown Artist')).rejects.toThrow(
      AudioSourceError
    );
  });

  it('should throw AudioSourceError when download returns HTML', async () => {
    // Invidious returns empty (all instances)
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

    // saavn.dev returns results but download returns HTML
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
