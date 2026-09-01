import { Context, InlineKeyboard, InputFile } from 'grammy';
import { logger } from '../utils/logger';
import {
  extractInstagramUrlFromText,
  validateAndNormalizeInstagramUrl,
} from '../validation/instagram';
import { getInstagramReel, cleanupTempFile } from '../services/instagram';
import { downloadMediaBuffer, identifySong, SongResult } from '../services/music-recognition';
import { getSongAudio, AudioSourceError } from '../services/audio-source';
import {
  generateJobId,
  getReelJob,
  ReelJobData,
  saveReelJob,
  cacheJobByShortcode,
  getCachedJobByShortcode,
} from '../services/cache';
import { checkRateLimit } from '../services/rate-limit';
import { buildGetSongKeyboard } from './keyboards';
import {
  formatErrorMessage,
  MusicNotFoundError,
  RateLimitError,
} from '../utils/errors';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MONTHS: Record<string, string> = {
  '01': 'January', '02': 'February', '03': 'March',
  '04': 'April', '05': 'May', '06': 'June',
  '07': 'July', '08': 'August', '09': 'September',
  '10': 'October', '11': 'November', '12': 'December',
};

/**
 * Formats an ISO date string (YYYY-MM-DD, YYYY-MM, or YYYY) into "DD Month YYYY".
 * If only a year is available, returns just the year.
 */
export function formatReleaseDate(dateStr: string): string {
  const trimmed = dateStr.trim();

  // ACRCloud may return YYYYMMDD without separators
  if (/^\d{8}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    const dayNum = parseInt(day, 10);
    const monthName = MONTHS[month] || month;
    return `${dayNum} ${monthName} ${year}`;
  }

  const parts = trimmed.split('-');
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  if (year && month && day) {
    const dayNum = parseInt(day, 10);
    const monthName = MONTHS[month] || month;
    return `${dayNum} ${monthName} ${year}`;
  }
  if (year && month) {
    const monthName = MONTHS[month] || month;
    return `${monthName} ${year}`;
  }
  return year || dateStr;
}

/**
 * Formats song metadata into the final minimal premium Telegram video caption.
 *
 * Format:
 * 🎵 {track} - {artist}
 *
 * 💿 {album}
 * 📅 {full date}
 */
export function formatSongCaption(song: SongResult): string {
  const title = escapeMarkdown(song.title);
  const artist = escapeMarkdown(song.artist);

  let caption = `🎵 ${title} \\\\- ${artist}`;

  const album = song.album ? escapeMarkdown(song.album) : undefined;
  const date = song.releaseDate ? formatReleaseDate(song.releaseDate) : undefined;

  if (album || date) {
    caption += '\\n';
    if (album) caption += `\\\\n💿 ${album}`;
    if (date) caption += `\\\\n📅 ${date}`;
  }

  return caption;
}

/**
 * Sends Instagram Reel video to Telegram chat with caption and inline keyboard as ONE message.
 * Tries direct media URL first; falls back to uploading Buffer via InputFile if direct URL fails.
 */
export async function sendReelVideoToTelegram(
  ctx: Context,
  mediaUrl: string,
  shortcode: string,
  caption?: string,
  replyMarkup?: InlineKeyboard,
  buffer?: Buffer
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    logger.error('Telegram video send failed: Chat ID is missing from context');
    return false;
  }

  // 1. Attempt sending by direct URL first
  try {
    logger.info('Sending video to Telegram by direct URL with caption', { mediaUrl });
    await ctx.api.sendVideo(chatId, mediaUrl, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });
    logger.info('Telegram video sent successfully via direct URL');
    return true;
  } catch (urlError) {
    logger.warn('Failed to send video to Telegram via direct URL. Attempting Buffer upload fallback...', urlError);
  }

  // 2. Fallback: Buffer upload via InputFile
  try {
    let videoBuf = buffer;
    if (!videoBuf) {
      videoBuf = await downloadMediaBuffer(mediaUrl);
    }

    if (videoBuf.length > 50 * 1024 * 1024) {
      logger.error('Telegram video send failed: Video exceeds Telegram 50MB bot upload limit', { size: videoBuf.length });
      return false;
    }

    const filename = `${shortcode || 'reel'}.mp4`;
    logger.info('Sending video to Telegram via InputFile Buffer upload with caption', { filename, size: videoBuf.length });
    await ctx.api.sendVideo(chatId, new InputFile(videoBuf, filename), {
      caption,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });
    logger.info('Telegram video sent successfully via Buffer upload');
    return true;
  } catch (bufError) {
    logger.error('Telegram video send failed', bufError);
    return false;
  }
}

/**
 * Safely edits a status message, ignoring errors (e.g. text unchanged, message deleted).
 */
async function editStatus(
  ctx: Context,
  statusMsg: { message_id: number } | undefined,
  text: string
): Promise<void> {
  if (statusMsg && ctx.chat?.id) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, text);
    } catch {
      // Message edit may fail if text is the same or message was deleted — safe to ignore
    }
  }
}

/**
 * Extracts audio from a video file using ffmpeg and sends it as a Telegram audio message.
 * Returns true if successful.
 */
async function extractAndSendAudio(
  ctx: Context,
  videoFilePath: string,
  title: string,
  artist: string,
  durationSeconds?: number
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const tempDir = path.join(os.tmpdir(), 'musify-audio');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const audioPath = path.join(
    tempDir,
    `${title.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.mp3`
  );

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        [
          '-i', videoFilePath,
          '-vn',
          '-acodec', 'libmp3lame',
          '-q:a', '2',
          '-y',
          audioPath,
        ],
        { timeout: 30_000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });

    const audioBuffer = fs.readFileSync(audioPath);
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('Extracted audio file is empty');
    }

    await ctx.api.sendAudio(
      chatId,
      new InputFile(audioBuffer, `${title}.mp3`),
      {
        title,
        performer: artist,
        duration: durationSeconds,
      }
    );

    logger.info('Audio extracted via ffmpeg and sent to Telegram', {
      title,
      artist,
      size: audioBuffer.length,
    });
    return true;
  } catch (err) {
    logger.warn('ffmpeg audio extraction failed, will fall back to search', err);
    return false;
  } finally {
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Re-fetches fresh Instagram media URL if initial recognition fails due to expired CDN link,
 * then retries ACRCloud music recognition.
 */
export async function refreshAndIdentify(job: ReelJobData): Promise<SongResult> {
  try {
    return await identifySong(job.mediaUrl);
  } catch (error) {
    if (error instanceof MusicNotFoundError) {
      throw error;
    }
    logger.warn(`Initial recognition failed for job ${job.jobId}. Re-fetching media URL from Instagram...`);
    const freshMedia = await getInstagramReel(job.reelUrl);
    const updatedJob: ReelJobData = {
      ...job,
      mediaUrl: freshMedia.mediaUrl,
    };
    await saveReelJob(updatedJob);
    return await identifySong(freshMedia.mediaUrl);
  }
}

/**
 * /start command handler
 */
export async function handleStart(ctx: Context): Promise<void> {
  const message =
    '🎵 *MUSIFY*\n\n' +
    'Instagram Reel\'dagi musiqani toping.\n\n' +
    'Instagram Reel linkini yuboring.';

  await ctx.reply(message, { parse_mode: 'Markdown' });
}

/**
 * /help command handler
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const message =
    '1. Instagram Reel linkini yuboring.\n' +
    '2. Video topilishini kuting.\n' +
    '3. Musify qo\'shiqni aniqlaydi.';

  await ctx.reply(message, { parse_mode: 'Markdown' });
}

/**
 * /about command handler
 */
export async function handleAbout(ctx: Context): Promise<void> {
  const message =
    '🎵 *Musify*\n' +
    'Instagram Reel Music Finder';

  await ctx.reply(message, { parse_mode: 'Markdown' });
}

/**
 * Processes incoming text message containing an Instagram Reel URL.
 *
 * Single status message flow (edited at each step via editMessageText):
 * 1. 🎬 Reel qabul qilindi / ⏳ Video olinmoqda...
 * 2. ⏳ Video tayyorlanmoqda... (downloading from Render)
 * 3. 🔍 Musiqa aniqlanmoqda... (ACRCloud)
 * 4. 🎵 MUSIQA TOPILDI (or deleted if no music)
 * 5. Video sent with caption + button (ONE message)
 * 6. Status message deleted
 *
 * Correct order per user request:
 * Reel URL → downloader → video Buffer → Telegram video → ACRCloud → music result
 */
export async function handleTextMessage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId && !(await checkRateLimit(userId))) {
    await ctx.reply(formatErrorMessage(new RateLimitError()));
    return;
  }

  const text = ctx.message?.text;
  if (!text) return;

  const urlInText = extractInstagramUrlFromText(text);

  if (!urlInText) {
    await ctx.reply('❌ Bu Instagram Reel linki emas.');
    return;
  }

  let statusMsg: { message_id: number } | undefined;
  let videoFilePath: string | undefined;

  try {
    const { normalizedUrl, shortcode } = validateAndNormalizeInstagramUrl(urlInText);
    const overallStart = Date.now();

    // Duplicate request protection: check if we recently processed this shortcode
    const existingJob = await getCachedJobByShortcode(shortcode);
    if (existingJob && existingJob.songTitle && existingJob.songArtist) {
      logger.info('Reusing existing recognition for shortcode', {
        shortcode,
        jobId: existingJob.jobId,
      });

      const captionText = formatSongCaption({
        title: existingJob.songTitle,
        artist: existingJob.songArtist,
        album: existingJob.songAlbum,
        releaseDate: existingJob.songReleaseDate,
      });
      const keyboard = buildGetSongKeyboard(existingJob.jobId);

      await sendReelVideoToTelegram(
        ctx,
        existingJob.mediaUrl,
        shortcode,
        captionText,
        keyboard
      );

      logger.info('[PERF] Duplicate request served from cache', {
        shortcode,
        duration: `${Date.now() - overallStart}ms`,
      });
      return;
    }

    // Send initial status message
    statusMsg = (await ctx.reply(
      '🎬 Reel qabul qilindi\n⏳ Video olinmoqda...'
    )) as { message_id: number };

    // If download takes >8s, show cold-start warning to user
    const slowWarningTimer = setTimeout(async () => {
      if (statusMsg && ctx.chat?.id) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          '⏳ Video olinmoqda... (server tayyorlanmoqda, biroz kuting)'
        ).catch(() => {});
      }
    }, 8_000);

    // Step 1: Fetch video via self-hosted Render downloader
    // This handles: POST /api/info → POST /api/jobs → poll → download to temp file + buffer
    let reelMedia;
    try {
      reelMedia = await getInstagramReel(normalizedUrl);
    } finally {
      clearTimeout(slowWarningTimer);
    }
    videoFilePath = reelMedia.videoFilePath;

    // Buffer returned directly from Instagram downloader —
    // eliminates disk re-read and potential re-download
    const downloadedBuffer = reelMedia.videoBuffer;
    if (downloadedBuffer) {
      logger.info('[PERF] Video buffer ready (from downloader)', { size: downloadedBuffer.length });
    }

    // Step 3: ACRCloud music recognition (on downloaded buffer, BEFORE sending video to user)
    await editStatus(ctx, statusMsg, '🔍 Musiqa aniqlanmoqda...');
    const recognitionStart = Date.now();
    let songResult: SongResult | undefined;
    try {
      songResult = await identifySong(downloadedBuffer || reelMedia.mediaUrl);
      if (songResult) {
        logger.info(`[PERF] Recognition result: ${songResult.artist} - ${songResult.title}`, {
          duration: `${Date.now() - recognitionStart}ms`,
        });
      }
    } catch (musicErr) {
      logger.info('[PERF] ACRCloud failed', {
        duration: `${Date.now() - recognitionStart}ms`,
      });
      if (musicErr instanceof MusicNotFoundError) {
        logger.info('No music recognized for reel', { shortcode });
      } else {
        logger.error('Music recognition failed for reel', musicErr);
      }
    }

    // Step 4: Build caption and keyboard
    let captionText = '🎵 Musiqa aniqlanmadi.';
    let keyboard: InlineKeyboard | undefined;
    const jobId = generateJobId();

    if (songResult) {
      captionText = formatSongCaption(songResult);
      keyboard = buildGetSongKeyboard(jobId);
    }

    // Step 5: Save job to cache (parallel with status delete)
    const jobData: ReelJobData = {
      jobId,
      reelUrl: normalizedUrl,
      mediaUrl: reelMedia.mediaUrl,
      videoFilePath: reelMedia.videoFilePath,
      shortcode: reelMedia.id || shortcode,
      createdAt: Date.now(),
      userId,
      chatId: ctx.chat?.id,
      songTitle: songResult?.title,
      songArtist: songResult?.artist,
      songAlbum: songResult?.album,
      songReleaseDate: songResult?.releaseDate,
    };

    // Save job + cache + delete status in parallel (independent operations)
    const saveStart = Date.now();
    await Promise.all([
      saveReelJob(jobData),
      cacheJobByShortcode(shortcode, jobId),
      ...(statusMsg && ctx.chat?.id
        ? [ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})]
        : []),
    ]);
    statusMsg = undefined; // prevent double-delete in finally
    logger.info('[PERF] Job cache save', { duration: `${Date.now() - saveStart}ms` });

    // Step 6: Send video with final caption + button
    const videoStart = Date.now();
    const videoSent = await sendReelVideoToTelegram(
      ctx,
      reelMedia.mediaUrl,
      reelMedia.id || shortcode,
      captionText,
      keyboard,
      downloadedBuffer
    );
    logger.info('[PERF] Telegram video send', {
      duration: `${Date.now() - videoStart}ms`,
    });

    if (!videoSent) {
      throw new Error('Telegram video send failed');
    }

    logger.info('[PERF] Total request', {
      duration: `${Date.now() - overallStart}ms`,
      jobId,
    });
  } catch (error: unknown) {
    logger.error('Error handling Instagram Reel URL', error);
    const userError = formatErrorMessage(error);

    if (statusMsg) {
      await ctx.api
        .editMessageText(ctx.chat!.id, statusMsg.message_id, userError)
        .catch(() => {
          ctx.reply(userError);
        });
    } else {
      await ctx.reply(userError);
    }
  } finally {
    // Do NOT delete the temp video file here.
    // The get_song callback needs it for ffmpeg audio extraction.
    // It will be cleaned up when the job expires from cache or on next request.
  }
}

/**
 * Handles callback queries.
 *
 * "get_song:<jobId>" — Extracts audio from cached video file via ffmpeg and sends it as Telegram audio.
 * Falls back to audio-source search if ffmpeg extraction fails.
 */
export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData) return;

  const userId = ctx.from?.id;
  if (userId && !(await checkRateLimit(userId))) {
    await ctx.answerCallbackQuery({
      text: '⏳ Juda ko\'p so\'rov yuborildi. Biroz kutib, qayta urinib ko\'ring.',
      show_alert: true,
    });
    return;
  }

  if (callbackData.startsWith('get_song:')) {
    const jobId = callbackData.split(':')[1];
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Answer the callback query IMMEDIATELY — prevents Telegram waiting animation timeout
    await ctx.answerCallbackQuery();

    try {
      const job = await getReelJob(jobId);

      if (!job || !job.songTitle || !job.songArtist) {
        await ctx.api.sendMessage(
          chatId,
          '⚠️ Qo\'shiq maʼlumotlari topilmadi. Reel linkini qayta yuboring.'
        );
        return;
      }

      // Callback security: verify the user owns this job
      if (job.userId && userId && job.userId !== userId) {
        logger.warn('Unauthorized callback access attempt', {
          jobId,
          jobUserId: job.userId,
          callbackUserId: userId,
        });
        await ctx.api.sendMessage(chatId, '⚠️ Bu sizning so\'rovngiz emas.');
        return;
      }

      await ctx.api.sendMessage(chatId, '⏳ Qo\'shiq yuklanmoqda...');

      // Try ffmpeg extraction from cached video file first
      let sent = false;
      if (job.videoFilePath && fs.existsSync(job.videoFilePath)) {
        sent = await extractAndSendAudio(
          ctx,
          job.videoFilePath,
          job.songTitle,
          job.songArtist
        );
        // Clean up video file after attempting extraction (whether it succeeded or not)
        cleanupTempFile(job.videoFilePath);
      }

      // Fallback: search and download audio from external source
      if (!sent) {
        const downloadStart = Date.now();
        const audio = await getSongAudio(job.songTitle, job.songArtist);
        logger.info('[PERF] Music download fallback', {
          duration: `${Date.now() - downloadStart}ms`,
        });

        await ctx.api.sendAudio(
          chatId,
          new InputFile(audio.buffer, `${audio.title}.mp3`),
          {
            title: audio.title,
            performer: audio.artist,
            duration: audio.durationSeconds,
          }
        );
      }

      logger.info('Audio file sent to Telegram', {
        jobId,
        title: job.songTitle,
        artist: job.songArtist,
      });
    } catch (error: unknown) {
      logger.error('Failed to send audio for get_song callback', error);

      let userMsg =
        '⚠️ Qo\'shiqni yuklab bo\'lmadi. Keyinroq qayta urinib ko\'ring.';
      if (error instanceof AudioSourceError) {
        userMsg = '⚠️ Qo\'shiq topilmadi. Keyinroq qayta urinib ko\'ring.';
      }
      await ctx.api.sendMessage(chatId, userMsg).catch(() => {});
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[\]]/g, '\\$&');
}
