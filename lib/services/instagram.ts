import axios from 'axios';
import { logger } from '../utils/logger';
import { validateAndNormalizeInstagramUrl } from '../validation/instagram';
import {
  InstagramApiError,
  PrivateOrDeletedReelError,
} from '../utils/errors';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface InstagramReelMedia {
  id: string;
  mediaUrl: string;
  videoFilePath?: string;
  videoBuffer?: Buffer;
  title?: string;
  thumbnailUrl?: string;
  duration?: number;
}

const RENDER_DOWNLOADER_URL =
  process.env.RENDER_DOWNLOADER_URL || 'https://musify-downloader.onrender.com';

// ── Timeout configuration ────────────────────────────────────────────────────
const API_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;

// ── Adaptive polling: fast first polls, then slower ──────────────────────────
const POLL_DELAYS_MS = [500, 800, 1000, 1200, 1500, 1500, 1500, 1500];
const MAX_POLL_ATTEMPTS = POLL_DELAYS_MS.length; // 8 attempts max

// ── Shortcode cache ──────────────────────────────────────────────────────────
const shortcodeCache = new Map<string, { result: InstagramReelMedia; expiresAt: number }>();
const SHORTCODE_CACHE_TTL_MS = 30 * 60 * 1000;

function getCachedReel(shortcode: string): InstagramReelMedia | null {
  const e = shortcodeCache.get(shortcode);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { shortcodeCache.delete(shortcode); return null; }
  return e.result;
}

function setCachedReel(shortcode: string, result: InstagramReelMedia): void {
  shortcodeCache.set(shortcode, { result, expiresAt: Date.now() + SHORTCODE_CACHE_TTL_MS });
}

function getTempDir(): string {
  const dir = path.join(os.tmpdir(), 'musify-downloads');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return dir;
}

export function cleanupTempFile(filePath?: string): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
  } catch { /* ignore */ }
}

export function isInstagramPageUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
      const pathname = parsed.pathname.toLowerCase();
      return pathname.startsWith('/reel/') || pathname.startsWith('/reels/') || pathname.startsWith('/p/') || pathname.startsWith('/tv/') || pathname.startsWith('/share/') || pathname.startsWith('/stories/');
    }
  } catch { return false; }
  return false;
}

export function isValidMediaUrl(urlStr: unknown): urlStr is string {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  if (isInstagramPageUrl(trimmed)) return false;
  return true;
}

export function sanitizeForLog(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForLog);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('key') || lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('auth') || lowerKey.includes('password')) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeForLog(value);
    }
  }
  return sanitized;
}

function extractMediaUrlFromResponse(data: Record<string, unknown>): string | null {
  const nested = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null;
  const candidates = [
    nested?.downloadUrl, nested?.video_url, nested?.media_url, nested?.url,
    data.video_url, data.media_url, data.url, data.download_url, data.file_url, data.content_url,
    (Array.isArray(data.urls) && data.urls[0] && (data.urls[0] as Record<string, unknown>).url),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).video_url : undefined),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).download_url : undefined),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).url : undefined),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && !isInstagramPageUrl(candidate)) return candidate;
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, method: 'GET' | 'POST', body?: Record<string, unknown>, timeoutMs = API_TIMEOUT_MS): Promise<{ data: any; durationMs: number }> {
  const start = Date.now();
  try {
    const config = { timeout: timeoutMs };
    const response = method === 'POST' ? await axios.post(url, body, config) : await axios.get(url, config);
    return { data: response.data, durationMs: Date.now() - start };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.message?.includes('timeout'))) {
      throw new InstagramApiError(`Downloader timeout after ${durationMs}ms`);
    }
    throw err;
  }
}

/**
 * Get Instagram Reel video via self-hosted Render downloader.
 *
 * Optimized flow:
 * 1. Check shortcode cache → if HIT, return immediately (~0ms)
 * 2. POST /api/jobs → create download job (skip /api/info — saves 5-10s)
 * 3. If response has direct URL → use it immediately (skip polling)
 * 4. Adaptive poll: 500ms → 800ms → 1000ms → 1500ms (max 8 polls)
 * 5. Download video to temp + buffer
 */
export async function getInstagramReel(url: string): Promise<InstagramReelMedia> {
  const totalStart = Date.now();
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);

  // ── Cache check ────────────────────────────────────────────────────────
  const cached = getCachedReel(shortcode);
  if (cached) {
    console.log(`[PERF] Instagram extraction START shortcode=${shortcode} cache=HIT`);
    console.log(`[PERF] Instagram extraction TOTAL duration=${Date.now() - totalStart}ms source=cache`);
    return cached;
  }

  console.log(`[PERF] Instagram extraction START shortcode=${shortcode}`);

  try {
    // ── 1. POST /api/jobs — create download job (skip /api/info) ─────────
    // /api/info adds 5-10s on cold start. We skip it entirely.
    // private/deleted detection happens via /api/jobs error response.
    const jobStart = Date.now();
    const { data: jobData, durationMs: jobDuration } = await fetchJsonWithTimeout(
      `${RENDER_DOWNLOADER_URL}/api/jobs`,
      'POST',
      { url: normalizedUrl, format: 'mp4', quality: '720p' },
      API_TIMEOUT_MS,
    );
    console.log(`[PERF] /api/jobs END duration=${jobDuration}ms`);

    if (!jobData) {
      throw new InstagramApiError('Empty response from downloader /api/jobs endpoint.');
    }

    // Check for private/deleted errors in job response
    const jobMsg = ((jobData.message || jobData.error || '') as string).toLowerCase();
    if (
      jobMsg.includes('private') || jobMsg.includes('deleted') ||
      jobMsg.includes('unavailable') ||
      (jobMsg.includes('reel') && jobMsg.includes('not found'))
    ) {
      throw new PrivateOrDeletedReelError();
    }

    // ── 2. Check for direct URL in response (skip polling) ───────────────
    const jobId = jobData.jobId || jobData.id || jobData.job_id;
    let fileUrl: string;

    if (jobId) {
      // Check if response already has a file URL
      const directUrlFromJob =
        jobData.fileUrl || jobData.file_url || jobData.downloadUrl || jobData.download_url || jobData.url;
      if (directUrlFromJob && typeof directUrlFromJob === 'string') {
        console.log(`[PERF] Direct URL from /api/jobs response — skipping poll`);
        fileUrl = directUrlFromJob;
      } else {
        // ── 3. Adaptive poll ─────────────────────────────────────────────
        const pollStart = Date.now();
        fileUrl = await pollJobStatus(jobId);
        console.log(`[PERF] Job poll COMPLETE duration=${Date.now() - pollStart}ms`);
      }
    } else {
      // No job ID — try to extract URL directly from response
      const directUrl = extractMediaUrlFromResponse(jobData);
      if (directUrl) {
        console.log(`[PERF] Direct URL extracted from /api/jobs response`);
        fileUrl = directUrl;
      } else {
        throw new InstagramApiError('No job ID or direct file URL returned from downloader.');
      }
    }

    // ── 4. Download video ────────────────────────────────────────────────
    const dlStart = Date.now();
    const { filePath: videoFilePath, buffer: videoBuffer } = await downloadToTempFile(fileUrl, shortcode);
    console.log(`[PERF] Video download END duration=${Date.now() - dlStart}ms size=${videoBuffer.length}`);

    const totalDuration = Date.now() - totalStart;
    console.log(`[PERF] Instagram extraction TOTAL duration=${totalDuration}ms`);

    const result: InstagramReelMedia = {
      id: shortcode,
      mediaUrl: fileUrl,
      videoFilePath,
      videoBuffer,
      title: jobData.title || jobData.caption || undefined,
      thumbnailUrl: jobData.thumbnail || jobData.thumbnail_url || undefined,
    };

    setCachedReel(shortcode, result);
    return result;
  } catch (error: unknown) {
    console.log(`[PERF] Instagram extraction FAILED duration=${Date.now() - totalStart}ms`);

    if (error instanceof PrivateOrDeletedReelError || error instanceof InstagramApiError) throw error;

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const providerMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      const lowerMsg = (providerMsg || '').toLowerCase();
      if (lowerMsg.includes('private') || lowerMsg.includes('deleted') || lowerMsg.includes('unavailable')) {
        throw new PrivateOrDeletedReelError();
      }
      throw new InstagramApiError(`Downloader HTTP ${status || 'error'}: ${providerMsg}`);
    }

    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}

/**
 * Adaptive polling: fast first polls (500ms), then slower (1500ms).
 * Max 8 attempts. Returns file URL when job completes.
 */
async function pollJobStatus(jobId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const delay = POLL_DELAYS_MS[attempt] || 1500;
    await sleep(delay);

    try {
      const { data, durationMs } = await fetchJsonWithTimeout(
        `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}`,
        'GET', undefined, POLL_TIMEOUT_MS,
      );

      const status = (data.status || data.state || '').toLowerCase();
      console.log(`[PERF] Job poll attempt=${attempt + 1} status=${status} duration=${durationMs}ms`);

      if (status === 'completed' || status === 'done' || status === 'finished' || status === 'success') {
        // Extract file URL from response
        const fileUrl = data.fileUrl || data.file_url || data.downloadUrl || data.download_url || data.url;
        if (fileUrl && typeof fileUrl === 'string') return fileUrl;
        return `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}/file`;
      }

      if (status === 'failed' || status === 'error') {
        throw new InstagramApiError(`Download job failed: ${data.error || data.message || 'unknown'}`);
      }
    } catch (err: unknown) {
      if (err instanceof InstagramApiError) throw err;
      // Transient errors — continue polling
    }
  }

  throw new InstagramApiError(`Download job timed out after ${MAX_POLL_ATTEMPTS} polls. Render server may be cold-starting.`);
}

async function downloadToTempFile(url: string, shortcode: string): Promise<{ filePath: string; buffer: Buffer }> {
  const start = Date.now();
  const tempDir = getTempDir();
  const filePath = path.join(tempDir, `${shortcode}_${Date.now()}.mp4`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS, maxRedirects: 5, signal: controller.signal,
    });
    const buffer = Buffer.from(response.data);
    fs.writeFileSync(filePath, buffer);
    console.log(`[PERF] Video download to file duration=${Date.now() - start}ms size=${buffer.length}`);
    return { filePath, buffer };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.message?.includes('timeout'))) {
      throw new InstagramApiError(`Video download timed out after ${Date.now() - start}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
