import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getSongAudio, AudioSourceError } from '../lib/services/audio-source';

vi.mock('axios');

describe('Audio Source Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should search saavn.dev and return downloaded audio buffer', async () => {
    // Invidious returns empty/no results (all instances)
    const invidiousEmpty = { data: [] };
    vi.mocked(axios.get)
      .mockResolvedValueOnce(invidiousEmpty as never) // inv.nadeko.net
      .mockResolvedValueOnce(invidiousEmpty as never) // invidious.fdn.fr
      .mockResolvedValueOnce(invidiousEmpty as never) // vid.puffyan.us
      .mockResolvedValueOnce(invidiousEmpty as never); // invidious.nerdvpn.de

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

    expect(axios.get).toHaveBeenCalledTimes(6);
    expect(axios.get).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.objectContaining({ timeout: 12000 })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      6,
      'https://cdn.example.com/high.mp3',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 20000 })
    );
  });

  it('should fall back to JioSaavn direct API when saavn.dev returns no results', async () => {
    // Invidious returns empty/no results
    const invidiousEmpty = { data: [] };
    vi.mocked(axios.get)
      .mockResolvedValueOnce(invidiousEmpty as never) // inv.nadeko.net
      .mockResolvedValueOnce(invidiousEmpty as never) // invidious.fdn.fr
      .mockResolvedValueOnce(invidiousEmpty as never) // vid.puffyan.us
      .mockResolvedValueOnce(invidiousEmpty as never); // invidious.nerdvpn.de

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

    // Should have called: 4 invidious + 1 saavn + 1 jiosaavn + 1 download = 7
    expect(axios.get).toHaveBeenCalledTimes(7);
    expect(axios.get).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('saavn.dev/api/search/songs'),
      expect.anything()
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      6,
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
    // Invidious returns empty
    const invidiousEmpty = { data: [] };
    vi.mocked(axios.get)
      .mockResolvedValueOnce(invidiousEmpty as never)
      .mockResolvedValueOnce(invidiousEmpty as never)
      .mockResolvedValueOnce(invidiousEmpty as never)
      .mockResolvedValueOnce(invidiousEmpty as never);

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
