import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface ReelJobData {
  jobId: string;
  reelUrl: string;
  mediaUrl: string;
  shortcode: string;
  createdAt: number;
  songTitle?: string;
  songArtist?: string;
  songAlbum?: string;
  songReleaseDate?: string;
  userId?: number;
  chatId?: number;
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

// Shortcode cache for duplicate detection (in-memory only, per-instance)
const shortcodeMemoryCache = new Map<string, { jobId: string; expiresAt: number }>();

const memoryCache = new MemoryStore();
let warnedMissingRedis = false;

export function getRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    try {
      return new Redis({ url, token });
    } catch (e) {
      logger.error('Failed to instantiate Upstash Redis client', e);
    }
  }

  if (!warnedMissingRedis) {
    logger.warn('Redis sozlanmagan — production\'da ishonchli ishlash uchun Upstash Redis talab qilinadi.');
    warnedMissingRedis = true;
  }
  return null;
}

const redisClient = getRedisClient();

export function generateJobId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Saves a Reel processing job.
 * Uses Redis as primary storage when available, with memory store for fast local lookups.
 */
export async function saveReelJob(jobData: ReelJobData): Promise<string> {
  const ttl = 3600; // 1 hour TTL
  const key = `musify:job:${jobData.jobId}`;

  const redis = getRedisClient() || redisClient;

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(jobData), { ex: ttl });
    } catch (err) {
      logger.error('Redis save error, falling back to memory store', err);
    }
  }

  // Memory store cache update
  memoryCache.set(key, jobData, ttl);

  return jobData.jobId;
}

/**
 * Retrieves a Reel processing job.
 * Redis is primary data source when available.
 */
export async function getReelJob(jobId: string): Promise<ReelJobData | null> {
  const key = `musify:job:${jobId}`;
  const redis = getRedisClient() || redisClient;

  if (redis) {
    try {
      const dataStr = await redis.get<string | object>(key);
      if (dataStr) {
        const parsed = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr as ReelJobData);
        memoryCache.set(key, parsed, 3600); // Backfill memory cache
        return parsed;
      }
    } catch (err) {
      logger.error('Redis read error, checking memory cache fallback', err);
    }
  }

  // Memory cache fallback
  return memoryCache.get(key);
}

/**
 * Caches a job ID by Instagram shortcode for duplicate detection.
 * TTL: 10 minutes — enough to catch rapid duplicate sends without stale data.
 */
export async function cacheJobByShortcode(shortcode: string, jobId: string): Promise<void> {
  const ttlMs = 10 * 60 * 1000;
  shortcodeMemoryCache.set(shortcode, { jobId, expiresAt: Date.now() + ttlMs });
}

/**
 * Looks up a recent job by Instagram shortcode for duplicate detection.
 * Returns the full job data if found and not expired, null otherwise.
 */
export async function getCachedJobByShortcode(shortcode: string): Promise<ReelJobData | null> {
  const cached = shortcodeMemoryCache.get(shortcode);
  if (!cached) return null;

  if (Date.now() > cached.expiresAt) {
    shortcodeMemoryCache.delete(shortcode);
    return null;
  }

  return await getReelJob(cached.jobId);
}
