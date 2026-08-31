import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface ReelJobData {
  jobId: string;
  reelUrl: string;
  mediaUrl: string;
  shortcode: string;
  createdAt: number;
}

class MemoryStore {
  private cache = new Map<string, { data: ReelJobData; expiresAt: number }>();

  set(key: string, data: ReelJobData, ttlSeconds: number = 3600): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { data, expiresAt });
  }

  get(key: string): ReelJobData | null {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }
}

const memoryCache = new MemoryStore();

/**
 * Initializes Redis client if environment variables are provided
 */
function getRedisClient(): Redis | null {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      return new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    } catch (e) {
      logger.error('Failed to initialize Upstash Redis REST client', e);
    }
  }
  return null;
}

const redisClient = getRedisClient();

/**
 * Generates a safe, short job ID (e.g. 12-char hex).
 */
export function generateJobId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Saves a Reel processing job into cache (Redis or Memory).
 */
export async function saveReelJob(jobData: ReelJobData): Promise<string> {
  const ttl = 3600; // 1 hour TTL
  const key = `musify:job:${jobData.jobId}`;

  // Always save to memory cache for fast local access
  memoryCache.set(key, jobData, ttl);

  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(jobData), { ex: ttl });
    } catch (err) {
      logger.error('Error writing job to Upstash Redis', err);
    }
  }

  return jobData.jobId;
}

/**
 * Retrieves a Reel processing job from cache.
 */
export async function getReelJob(jobId: string): Promise<ReelJobData | null> {
  const key = `musify:job:${jobId}`;

  // 1. Try memory cache first
  const memoryResult = memoryCache.get(key);
  if (memoryResult) {
    return memoryResult;
  }

  // 2. Try Redis if available
  if (redisClient) {
    try {
      const dataStr = await redisClient.get<string | object>(key);
      if (dataStr) {
        const parsed = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr as ReelJobData);
        memoryCache.set(key, parsed, 3600); // Backfill memory cache
        return parsed;
      }
    } catch (err) {
      logger.error('Error fetching job from Upstash Redis', err);
    }
  }

  return null;
}
