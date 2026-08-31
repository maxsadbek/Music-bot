import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateJobId, getReelJob, saveReelJob, ReelJobData } from '../lib/services/cache';

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
});
