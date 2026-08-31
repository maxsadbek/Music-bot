import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateJobId, getReelJob, saveReelJob, ReelJobData, cacheJobByShortcode, getCachedJobByShortcode } from '../lib/services/cache';

describe('Job Cache Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should save and retrieve job from cache (in-memory fallback)', async () => {
    const jobId = generateJobId();
    const mockJob: ReelJobData = {
      jobId,
      reelUrl: 'https://www.instagram.com/reel/Db2K5ZCIsGc/',
      mediaUrl: 'https://cdn.example.com/video.mp4',
      shortcode: 'Db2K5ZCIsGc',
      createdAt: Date.now(),
    };

    await saveReelJob(mockJob);
    const retrieved = await getReelJob(jobId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.jobId).toBe(jobId);
    expect(retrieved?.mediaUrl).toBe('https://cdn.example.com/video.mp4');
  });

  it('should return null for non-existent job key', async () => {
    const result = await getReelJob('non_existent_job_123');
    expect(result).toBeNull();
  });

  it('should store and retrieve extended job metadata', async () => {
    const jobId = generateJobId();
    const mockJob: ReelJobData = {
      jobId,
      reelUrl: 'https://www.instagram.com/reel/Db2K5ZCIsGc/',
      mediaUrl: 'https://cdn.example.com/video.mp4',
      shortcode: 'Db2K5ZCIsGc',
      createdAt: Date.now(),
      songTitle: 'United In Grief',
      songArtist: 'Kendrick Lamar',
      songAlbum: 'Mr. Morale & The Big Steppers',
      songReleaseDate: '2022-05-13',
      userId: 999,
      chatId: 12345,
    };

    await saveReelJob(mockJob);
    const retrieved = await getReelJob(jobId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.songTitle).toBe('United In Grief');
    expect(retrieved?.songArtist).toBe('Kendrick Lamar');
    expect(retrieved?.songAlbum).toBe('Mr. Morale & The Big Steppers');
    expect(retrieved?.songReleaseDate).toBe('2022-05-13');
    expect(retrieved?.userId).toBe(999);
    expect(retrieved?.chatId).toBe(12345);
  });

  it('should cache and retrieve job by shortcode', async () => {
    const jobId = generateJobId();
    const shortcode = 'Db2K5ZCIsGc';

    // Save the job first
    const mockJob: ReelJobData = {
      jobId,
      reelUrl: 'https://www.instagram.com/reel/Db2K5ZCIsGc/',
      mediaUrl: 'https://cdn.example.com/video.mp4',
      shortcode,
      createdAt: Date.now(),
      songTitle: 'Test Song',
      songArtist: 'Test Artist',
    };
    await saveReelJob(mockJob);

    // Cache by shortcode
    await cacheJobByShortcode(shortcode, jobId);

    // Retrieve by shortcode
    const retrieved = await getCachedJobByShortcode(shortcode);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.jobId).toBe(jobId);
    expect(retrieved?.songTitle).toBe('Test Song');
  });

  it('should return null for non-existent shortcode cache', async () => {
    const result = await getCachedJobByShortcode('non_existent_shortcode');
    expect(result).toBeNull();
  });
});
