import axios, { AxiosError } from 'axios';
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
// Render free tier cold-starts after ~15min idle. First request can take 5-30s.
// We fail fast instead of blocking the user for 30s.
const API_TIMEOUT_MS = 10_000;       // /api/info and /api/jobs
const POLL_TIMEOUT_MS = 8_000;       // per poll attempt
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 15;        // 15 × 1.5s = 22.5s max poll time
const DOWNLOAD_TIMEOUT_MS = 30_000;  // video file download (files can be large)
const COLD_START_THRESHOLD_MS = 5_000; // if API response >5s, likely cold start

function getTempDir(): string {
  const dir = path.join(os.tmpdir(), 'musify-downloads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function cleanupTempFile(filePath?: string): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info('[IG] Cleaned up temp file', { filePath });
    }
  } catch (err) {
    logger.warn('[IG] Failed to clean up temp file', { filePath, error: err });
  }
}

/**
 * Checks whether a given URL string is an Instagram page URL (post, reel, etc.),
 * rather than a direct downloadable media asset URL.
 */
export function isInstagramPageUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
      const pathname = parsed.pathname.toLowerCase();
      if (
        pathname.startsWith('/reel/') ||
        pathname.startsWith('/reels/') ||
        pathname.startsWith('/p/') ||
        pathname.startsWith('/tv/') ||
        pathname.startsWith('/share/') ||
        pathname.startsWith('/stories/') ||
        pathname === '/'
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Validates that a candidate URL string is a valid HTTP(S) URL and NOT an Instagram page URL.
 */
export function isValidMediaUrl(urlStr: unknown): urlStr is string {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  if (isInstagramPageUrl(trimmed)) return false;
  return true;
}

/**
 * Recursively redacts sensitive fields (access keys, tokens, secrets) for safe logging.
 */
export function sanitizeForLog(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForLog);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('password')
    ) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeForLog(value);
    }
  }
  return sanitized;
}

/**
 * Extracts a direct media URL from a provider response body.
 * Handles multiple response shapes from various providers.
 */
function extractMediaUrlFromResponse(data: Record<string, unknown>): string | null {
  const nested = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null;

  const candidates = [
    nested?.downloadUrl,
    nested?.video_url,
    nested?.media_url,
    nested?.url,
    data.video_url,
    data.media_url,
    data.url,
    data.download_url,
    data.file_url,
    data.content_url,
    (Array.isArray(data.urls) && data.urls[0] && (data.urls[0] as Record<string, unknown>).url),
    (Array.isArray(data.data) && data.data[0] && (data.data[0] as Record<string, unknown>).url),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).video_url : undefined),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).download_url : undefined),
    (data.result && typeof data.result === 'object' ? (data.result as Record<string, unknown>).url : undefined),
    (data.result && typeof data.result === 'object' && (data.result as Record<string, unknown>).download
      ? ((data.result as Record<string, unknown>).download as Record<string, unknown>).url
      : undefined),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && !isInstagramPageUrl(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Fetches JSON from a URL with axios timeout.
 * Returns the parsed JSON data, or throws on timeout/error.
 */
async function fetchJsonWithTimeout(
  url: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  timeoutMs = API_TIMEOUT_MS,
): Promise<{ data: any; durationMs: number }> {
  const start = Date.now();

  try {
    const config = { timeout: timeoutMs };

    let response;
    if (method === 'POST') {
      response = await axios.post(url, body, config);
    } else {
      response = await axios.get(url, config);
    }

    const durationMs = Date.now() - start;
    return { data: response.data, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.message?.includes('timeout'))) {
      logger.warn('[PERF] Downloader TIMEOUT', { url, timeoutMs, durationMs });
      throw new InstagramApiError(`Downloader request timed out after ${durationMs}ms`);
    }
    throw err;
  }
}

/**
 * Service for retrieving Instagram Reel video via the self-hosted Render downloader.
 *
 * Flow:
 * 1. POST /api/info  — validate reel URL and get metadata (OPTIONAL — skipped on timeout)
 * 2. POST /api/jobs  — create a download job (REQUIRED)
 * 3. GET  /api/jobs/:id — poll until job completes
 * 4. Download video file to temp + return buffer in memory
 */
export async function getInstagramReel(url: string): Promise<InstagramReelMedia> {
  const totalStart = Date.now();
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);

  console.log(`[PERF] Instagram downloader START shortcode=${shortcode} url=${RENDER_DOWNLOADER_URL}`);

  try {
    // ── 1. POST /api/info — validate reel and get metadata (OPTIONAL) ──────
    // On Render free tier cold-start, this can take 5-30s. We set a short
    // timeout and skip metadata if it fails — /api/jobs is the critical path.
    let title: string | undefined;
    let thumbnailUrl: string | undefined;
    let infoFailed = false;

    try {
      const { data: infoData, durationMs: infoDuration } = await fetchJsonWithTimeout(
        `${RENDER_DOWNLOADER_URL}/api/info`,
        'POST',
        { url: normalizedUrl },
        API_TIMEOUT_MS,
      );

      console.log(`[PERF] /api/info response: ${infoDuration}ms`);

      // Cold-start detection: if response >5s, Render was likely cold
      if (infoDuration > COLD_START_THRESHOLD_MS) {
        console.log(`[PERF] Downloader cold-start detected: ${infoDuration}ms (threshold ${COLD_START_THRESHOLD_MS}ms)`);
      }

      if (infoData) {
        const infoMsg = (infoData.message || infoData.error || '').toLowerCase();
        if (
          infoMsg.includes('private') ||
          infoMsg.includes('deleted') ||
          infoMsg.includes('unavailable') ||
          (infoMsg.includes('reel') && infoMsg.includes('not found'))
        ) {
          logger.error('[IG] Provider explicitly reports reel as private/deleted/unavailable');
          throw new PrivateOrDeletedReelError();
        }

        title = infoData.title || infoData.caption || infoData.description || undefined;
        thumbnailUrl = infoData.thumbnail || infoData.thumbnail_url || infoData.cover || undefined;
      }
    } catch (infoErr: unknown) {
      // /api/info is optional — skip on timeout and continue to /api/jobs
      if (infoErr instanceof PrivateOrDeletedReelError) throw infoErr;

      // Check axios error response for private/deleted messages
      if (axios.isAxiosError(infoErr)) {
        const providerMsg = (
          infoErr.response?.data?.message ||
          infoErr.response?.data?.error ||
          ''
        ).toLowerCase();
        if (
          providerMsg.includes('private') ||
          providerMsg.includes('deleted') ||
          providerMsg.includes('unavailable') ||
          (providerMsg.includes('reel') && providerMsg.includes('not found'))
        ) {
          logger.error('[IG] Provider reports reel as private/deleted via HTTP error');
          throw new PrivateOrDeletedReelError();
        }
      }

      infoFailed = true;
      logger.warn('[PERF] /api/info FAILED — skipping metadata, continuing to /api/jobs', {
        error: infoErr instanceof Error ? infoErr.message : String(infoErr),
      });
    }

    // ── 2. POST /api/jobs — create download job (REQUIRED) ────────────────
    const jobStart = Date.now();
    const { data: jobData, durationMs: jobDuration } = await fetchJsonWithTimeout(
      `${RENDER_DOWNLOADER_URL}/api/jobs`,
      'POST',
      { url: normalizedUrl, format: 'mp4', quality: '720p' },
      API_TIMEOUT_MS,
    );

    console.log(`[PERF] /api/jobs response: ${jobDuration}ms`);

    if (jobDuration > COLD_START_THRESHOLD_MS) {
      console.log(`[PERF] Downloader cold-start detected (jobs): ${jobDuration}ms`);
    }

    if (!jobData) {
      throw new InstagramApiError('Empty response from downloader /api/jobs endpoint.');
    }

    // ── Check response type ───────────────────────────────────────────────
    const jobId = jobData.jobId || jobData.id || jobData.job_id;

    if (!jobId) {
      // Some APIs return the file URL directly without a job ID
      const directUrl = extractMediaUrlFromResponse(jobData);
      if (directUrl) {
        console.log(`[PERF] Downloader response type: DIRECT_URL`);
        const { filePath: videoFilePath, buffer: videoBuffer } = await downloadToTempFile(directUrl, shortcode);
        logger.info('[PERF] Instagram downloader total', { duration: `${Date.now() - totalStart}ms` });
        return {
          id: shortcode,
          mediaUrl: directUrl,
          videoFilePath,
          videoBuffer,
          title,
          thumbnailUrl: thumbnailUrl || undefined,
        };
      }
      throw new InstagramApiError('No job ID or direct file URL returned from downloader.');
    }

    console.log(`[PERF] Downloader response type: JOB_ID jobId=${jobId}`);

    // ── 3. Poll job status ────────────────────────────────────────────────
    const pollStart = Date.now();
    logger.info('[IG] Step 3: Polling job status', { jobId });
    const fileUrl = await pollJobStatus(jobId);
    console.log(`[PERF] Job poll complete: ${Date.now() - pollStart}ms`);

    // ── 4. Download video file ────────────────────────────────────────────
    const dlStart = Date.now();
    logger.info('[IG] Step 4: Downloading video file');
    const { filePath: videoFilePath, buffer: videoBuffer } = await downloadToTempFile(fileUrl, shortcode);
    console.log(`[PERF] Video file download: ${Date.now() - dlStart}ms size=${videoBuffer.length}`);

    console.log(`[PERF] Instagram downloader total: ${Date.now() - totalStart}ms infoSkipped=${infoFailed}`);

    return {
      id: shortcode,
      mediaUrl: fileUrl,
      videoFilePath,
      videoBuffer,
      title,
      thumbnailUrl: thumbnailUrl || undefined,
    };
  } catch (error: unknown) {
    logger.error('[PERF] Instagram downloader FAILED', {
      duration: `${Date.now() - totalStart}ms`,
    });

    if (
      error instanceof PrivateOrDeletedReelError ||
      error instanceof InstagramApiError
    ) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const providerMsg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message;

      logger.error(`[IG] Downloader HTTP ${status || 'unknown'}`, providerMsg);

      const lowerMsg = (providerMsg || '').toLowerCase();

      if (
        lowerMsg.includes('private') ||
        lowerMsg.includes('deleted') ||
        lowerMsg.includes('unavailable') ||
        (lowerMsg.includes('reel') && lowerMsg.includes('not found'))
      ) {
        logger.error('[IG] Provider explicitly reports reel as private/deleted/unavailable');
        throw new PrivateOrDeletedReelError();
      }

      throw new InstagramApiError(
        `Downloader returned HTTP ${status || 'error'}: ${providerMsg}`
      );
    }

    logger.error('[IG] Unexpected error fetching Instagram Reel', error);
    throw new InstagramApiError('Failed to retrieve Instagram Reel media.');
  }
}

/**
 * Polls the job status endpoint until the job completes or times out.
 * Uses 8s timeout per poll to avoid blocking on cold Render server.
 */
async function pollJobStatus(jobId: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const { data, durationMs } = await fetchJsonWithTimeout(
        `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}`,
        'GET',
        undefined,
        POLL_TIMEOUT_MS,
      );

      const status = (data.status || data.state || '').toLowerCase();

      logger.info('[PERF] IG job poll', {
        jobId,
        attempt,
        status,
        duration: `${durationMs}ms`,
      });

      if (status === 'completed' || status === 'done' || status === 'finished' || status === 'success') {
        // Job completed — extract file URL
        const fileUrl =
          data.fileUrl ||
          data.file_url ||
          data.downloadUrl ||
          data.download_url ||
          data.url ||
          (data.result && typeof data.result === 'object'
            ? (data.result as Record<string, unknown>).url ||
              (data.result as Record<string, unknown>).file_url ||
              (data.result as Record<string, unknown>).download_url
            : undefined);

        if (fileUrl && typeof fileUrl === 'string') {
          logger.info('[PERF] Job completed with direct URL');
          return fileUrl;
        }

        // If no direct file URL, construct it from the job ID
        const constructedUrl = `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}/file`;
        logger.info('[PERF] Job completed, using constructed file URL');
        return constructedUrl;
      }

      if (status === 'failed' || status === 'error') {
        const errorMsg = data.error || data.message || 'Download job failed';
        throw new InstagramApiError(`Download job failed: ${errorMsg}`);
      }

      // Job still processing — continue polling
    } catch (err: unknown) {
      if (err instanceof InstagramApiError) throw err;
      // Transient poll errors — continue polling
      if (axios.isAxiosError(err)) {
        logger.warn('[IG] Job poll HTTP error', {
          jobId,
          attempt,
          status: err.response?.status,
          message: err.message,
        });
      } else {
        logger.warn('[IG] Job poll unexpected error', { jobId, attempt, error: err });
      }
    }
  }

  throw new InstagramApiError(
    `Download job timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. The Render server may be cold-starting.`
  );
}

/**
 * Downloads a file from a URL to a temp file AND returns the buffer in memory.
 * The temp file is kept for later ffmpeg audio extraction in get_song callbacks.
 * The buffer is used immediately for ACRCloud recognition and Telegram upload.
 */
async function downloadToTempFile(url: string, shortcode: string): Promise<{ filePath: string; buffer: Buffer }> {
  const start = Date.now();
  const tempDir = getTempDir();
  const filePath = path.join(tempDir, `${shortcode}_${Date.now()}.mp4`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      signal: controller.signal,
    });

    const buffer = Buffer.from(response.data);
    fs.writeFileSync(filePath, buffer);

    logger.info('[PERF] Video download to temp file', {
      size: buffer.length,
      duration: `${Date.now() - start}ms`,
    });

    return { filePath, buffer };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.message?.includes('timeout'))) {
      logger.error('[PERF] Video download TIMEOUT', { duration: `${durationMs}ms` });
      throw new InstagramApiError(`Video download timed out after ${durationMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
