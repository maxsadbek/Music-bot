import { getRedisClient } from './cache';
import { logger } from '../utils/logger';

const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_WINDOW = 5;

// Memory fallback store for rate limiting when Redis is absent
const memoryRateLimitMap = new Map<number, { count: number; resetAt: number }>();

/**
 * Checks rate limit for a user ID.
 * Limits to 5 requests per 60 seconds window.
 * Returns true if allowed, false if limit exceeded.
 */
export async function checkRateLimit(userId: number): Promise<boolean> {
  if (!userId) return true;

  const redis = getRedisClient();

  if (redis) {
    try {
      const key = `musify:ratelimit:${userId}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      }
      return count <= MAX_REQUESTS_PER_WINDOW;
    } catch (err) {
      logger.error('Redis rate limit error, falling back to memory check', err);
    }
  }

  // Memory fallback rate limiter
  const now = Date.now();
  const userRecord = memoryRateLimitMap.get(userId);

  if (!userRecord || now > userRecord.resetAt) {
    memoryRateLimitMap.set(userId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_SECONDS * 1000,
    });
    return true;
  }

  if (userRecord.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  userRecord.count += 1;
  return true;
}
