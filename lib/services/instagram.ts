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
  title?: string;
  thumbnailUrl?: string;
  duration?: number;
}

const RENDER_DOWNLOADER_URL =
  process.env.RENDER_DOWNLOADER_URL || 'https://musify-downloader.onrender.com';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;
const JOB_TIMEOUT_MS = 60_000;

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
 * Service for retrieving Instagram Reel video via the self-hosted Render downloader.
 *
 * Flow:
 * 1. POST /api/info  — validate reel URL and get metadata
 * 2. POST /api/jobs  — create a download job
 * 3. GET  /api/jobs/:id — poll until job completes
 * 4. GET  /api/jobs/:id/file — download the video file
 */
export async function getInstagramReel(url: string): Promise<InstagramReelMedia> {
  const { shortcode, normalizedUrl } = validateAndNormalizeInstagramUrl(url);

  logger.info('[IG] Instagram request started', {
    shortcode,
    renderDownloaderUrl: RENDER_DOWNLOADER_URL,
  });

  try {
    // 1. POST /api/info — validate reel and get metadata
    logger.info('[IG] Step 1: Validating reel via /api/info');
    const infoResponse = await axios.post(
      `${RENDER_DOWNLOADER_URL}/api/info`,
      { url: normalizedUrl },
      { timeout: 30_000 }
    );
    logger.info('[IG] /api/info response status:', infoResponse.status);
    logger.info('[IG] /api/info response body:', sanitizeForLog(infoResponse.data));

    const infoData = infoResponse.data;
    if (!infoData) {
      throw new InstagramApiError('Empty response from downloader /api/info endpoint.');
    }

    // Check if the provider explicitly says the reel is private/deleted
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

    const title = infoData.title || infoData.caption || infoData.description || undefined;
    const thumbnailUrl = infoData.thumbnail || infoData.thumbnail_url || infoData.cover || undefined;

    // 2. POST /api/jobs — create download job
    logger.info('[IG] Step 2: Creating download job via /api/jobs');
    const jobResponse = await axios.post(
      `${RENDER_DOWNLOADER_URL}/api/jobs`,
      { url: normalizedUrl, format: 'mp4', quality: '720p' },
      { timeout: 30_000 }
    );
    logger.info('[IG] /api/jobs response status:', jobResponse.status);
    logger.info('[IG] /api/jobs response body:', sanitizeForLog(jobResponse.data));

    const jobData = jobResponse.data;
    if (!jobData) {
      throw new InstagramApiError('Empty response from downloader /api/jobs endpoint.');
    }

    const jobId = jobData.jobId || jobData.id || jobData.job_id;
    if (!jobId) {
      // Some APIs might return the file URL directly without a job ID
      const directUrl = extractMediaUrlFromResponse(jobData);
      if (directUrl) {
        logger.info('[IG] Direct file URL returned from /api/jobs');
        const videoFilePath = await downloadToTempFile(directUrl, shortcode);
        return {
          id: shortcode,
          mediaUrl: directUrl,
          videoFilePath,
          title,
          thumbnailUrl: thumbnailUrl || undefined,
        };
      }
      throw new InstagramApiError('No job ID or direct file URL returned from downloader.');
    }

    // 3. GET /api/jobs/:id — poll until job completes
    logger.info('[IG] Step 3: Polling job status', { jobId });
    const fileUrl = await pollJobStatus(jobId);

    // 4. GET /api/jobs/:id/file — download the video file
    logger.info('[IG] Step 4: Downloading video file');
    const videoFilePath = await downloadToTempFile(fileUrl, shortcode);

    return {
      id: shortcode,
      mediaUrl: fileUrl,
      videoFilePath,
      title,
      thumbnailUrl: thumbnailUrl || undefined,
    };
  } catch (error: unknown) {
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

      // Only treat as private/deleted when the provider explicitly says so
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
 * Returns the file URL when ready.
 */
async function pollJobStatus(jobId: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const statusResponse = await axios.get(
        `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}`,
        { timeout: 15_000 }
      );

      const data = statusResponse.data;
      const status = (data.status || data.state || '').toLowerCase();

      logger.info('[IG] Job poll', { jobId, attempt, status });

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
          return fileUrl;
        }

        // If no direct file URL, construct it from the job ID
        return `${RENDER_DOWNLOADER_URL}/api/jobs/${jobId}/file`;
      }

      if (status === 'failed' || status === 'error') {
        const errorMsg = data.error || data.message || 'Download job failed';
        throw new InstagramApiError(`Download job failed: ${errorMsg}`);
      }

      // Job still processing — continue polling
    } catch (err: unknown) {
      if (err instanceof InstagramApiError) throw err;
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
      // Continue polling on transient errors
    }
  }

  throw new InstagramApiError(
    `Download job timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. The Render server may be cold-starting.`
  );
}

/**
 * Downloads a file from a URL to a temp file and returns the local path.
 */
async function downloadToTempFile(url: string, shortcode: string): Promise<string> {
  const tempDir = getTempDir();
  const filePath = path.join(tempDir, `${shortcode}_${Date.now()}.mp4`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxRedirects: 5,
  });

  const buffer = Buffer.from(response.data);
  fs.writeFileSync(filePath, buffer);

  logger.info('[IG] Downloaded video to temp file', {
    filePath,
    size: buffer.length,
  });

  return filePath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
