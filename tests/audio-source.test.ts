import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getSongAudio, AudioSourceError } from '../lib/services/audio-source';

vi.mock('axios');

const INSTANCE_COUNT = 3;

const invidiousEmpty = { data: [] };

describe('Audio Source Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should search saavn.dev and return downloaded audio buffer', async () => {
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

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
  });

  it('should fall back to JioSaavn direct API when saavn.dev returns no results', async () => {
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { results: [] } } } as never);

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
  });

  it('should throw AudioSourceError when no search results are found from any provider', async () => {
    vi.mocked(axios.get)
      .mockResolvedValue({ data: [] } as never);

    await expect(getSongAudio('Unknown Track', 'Unknown Artist')).rejects.toThrow(
      AudioSourceError
    );
  });

  it('should throw AudioSourceError when download returns HTML', async () => {
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      vi.mocked(axios.get).mockResolvedValueOnce(invidiousEmpty as never);
    }

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
