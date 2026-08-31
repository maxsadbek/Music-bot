import { Context, InputFile } from 'grammy';
import { logger } from '../utils/logger';
import {
  extractInstagramUrlFromText,
  validateAndNormalizeInstagramUrl,
} from '../validation/instagram';
import { getInstagramReel } from '../services/instagram';
import { downloadMediaBuffer, identifySong, SongResult } from '../services/music-recognition';
import { generateJobId, getReelJob, ReelJobData, saveReelJob } from '../services/cache';
import { checkRateLimit } from '../services/rate-limit';
import {
  buildFindMusicKeyboard,
  buildRetryKeyboard,
  buildSongLinksKeyboard,
} from './keyboards';
import {
  formatErrorMessage,
  MusicNotFoundError,
  RateLimitError,
} from '../utils/errors';

/**
 * Sends Instagram Reel video to Telegram chat.
 * Tries direct media URL first; falls back to uploading Buffer via InputFile if direct URL fails.
 */
export async function sendReelVideoToTelegram(
  ctx: Context,
  mediaUrl: string,
  shortcode: string,
  buffer?: Buffer
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    logger.error('Telegram video send failed: Chat ID is missing from context');
    return false;
  }

  // 1. Attempt sending by direct URL first
  try {
    logger.info('Sending video to Telegram by direct URL', { mediaUrl });
    await ctx.api.sendVideo(chatId, mediaUrl);
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
    logger.info('Sending video to Telegram via InputFile Buffer upload', { filename, size: videoBuf.length });
    await ctx.api.sendVideo(chatId, new InputFile(videoBuf, filename));
    logger.info('Telegram video sent successfully via Buffer upload');
    return true;
  } catch (bufError) {
    logger.error('Telegram video send failed', bufError);
    return false;
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
    '3. 🎵 *Musiqani topish* tugmasini bosing.\n' +
    '4. Musify qo‘shiqni aniqlaydi.';

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
 * Processes incoming text message containing an Instagram Reel URL
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

  let statusMsg;
  try {
    const { normalizedUrl, shortcode } = validateAndNormalizeInstagramUrl(urlInText);

    // Step 1: Status message 🎬 Reel qabul qilindi
    statusMsg = await ctx.reply('🎬 Reel qabul qilindi\n\n⏳ Video olinmoqda...');

    // Step 2: Fetch direct video media URL from SocialKit
    const reelMedia = await getInstagramReel(normalizedUrl);

    // Update status to 🎥 Video yuboriladi
    if (statusMsg) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '🎥 Video yuboriladi...'
      ).catch(() => {});
    }

    // Pre-download media buffer once to reuse for both Telegram upload fallback and ACRCloud recognition
    let downloadedBuffer: Buffer | undefined;
    try {
      downloadedBuffer = await downloadMediaBuffer(reelMedia.mediaUrl);
    } catch (downloadErr) {
      logger.warn('Pre-downloading media buffer failed, fallback to URL download for recognition', downloadErr);
    }

    // Step 3: Send video to Telegram AND AWAIT COMPLETION FIRST
    const videoSent = await sendReelVideoToTelegram(
      ctx,
      reelMedia.mediaUrl,
      reelMedia.id || shortcode,
      downloadedBuffer
    );

    if (!videoSent) {
      logger.error('Telegram video send failed');
    }

    // Step 4: ONLY AFTER video send completion, update status to 🔍 Musiqa aniqlanmoqda...
    if (statusMsg) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '🔍 Musiqa aniqlanmoqda...'
      ).catch(() => {});
    }

    // Save job to cache
    const jobId = generateJobId();
    await saveReelJob({
      jobId,
      reelUrl: normalizedUrl,
      mediaUrl: reelMedia.mediaUrl,
      shortcode: reelMedia.id || shortcode,
      createdAt: Date.now(),
    });

    // Step 5: Perform ACRCloud music recognition (only after video sending completed)
    const song = await identifySong(downloadedBuffer || reelMedia.mediaUrl);

    // Step 6: Send recognized music information
    let successMessage = '🎵 *MUSIQA TOPILDI*\n\n';
    successMessage += `🎤 *Artist:* ${escapeMarkdown(song.artist)}\n`;
    successMessage += `🎵 *Track:* ${escapeMarkdown(song.title)}\n`;
    if (song.album) {
      successMessage += `💿 *Album:* ${escapeMarkdown(song.album)}\n`;
    }
    if (song.releaseDate) {
      successMessage += `📅 *Released:* ${escapeMarkdown(song.releaseDate)}\n`;
    }

    const keyboard = buildSongLinksKeyboard(song);

    if (statusMsg) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        successMessage,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );
    } else {
      await ctx.reply(successMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }

    logger.info('Telegram response sent', { jobId });
  } catch (error: unknown) {
    logger.error('Error handling Instagram Reel URL', error);
    const userError = formatErrorMessage(error);

    if (statusMsg) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        userError
      ).catch(() => {
        ctx.reply(userError);
      });
    } else {
      await ctx.reply(userError);
    }
  }
}

/**
 * Handles callback queries for "find_music:<jobId>" and "retry_music:<jobId>"
 */
export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData) return;

  const userId = ctx.from?.id;
  if (userId && !(await checkRateLimit(userId))) {
    await ctx.answerCallbackQuery({
      text: '⏳ Juda ko‘p so‘rov yuborildi. Biroz kutib, qayta urinib ko‘ring.',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();

  const messageId = ctx.callbackQuery.message?.message_id;
  const chatId = ctx.callbackQuery.message?.chat?.id;

  if (!messageId || !chatId) return;

  if (callbackData.startsWith('find_music:') || callbackData.startsWith('retry_music:')) {
    const jobId = callbackData.split(':')[1];

    try {
      await ctx.api.editMessageText(
        chatId,
        messageId,
        '🔍 Musiqa aniqlanmoqda...'
      );

      const job = await getReelJob(jobId);

      if (!job) {
        await ctx.api.editMessageText(
          chatId,
          messageId,
          '⚠️ So‘rov muddati o‘tgan. Iltimos, Reel linkini qayta yuboring.'
        );
        return;
      }

      // Use refreshAndIdentify to handle potentially expired media URLs on retry
      const song = await refreshAndIdentify(job);

      let successMessage = '🎵 *MUSIQA TOPILDI*\n\n';
      successMessage += `🎤 *Artist:* ${escapeMarkdown(song.artist)}\n`;
      successMessage += `🎵 *Track:* ${escapeMarkdown(song.title)}\n`;
      if (song.album) {
        successMessage += `💿 *Album:* ${escapeMarkdown(song.album)}\n`;
      }
      if (song.releaseDate) {
        successMessage += `📅 *Released:* ${escapeMarkdown(song.releaseDate)}\n`;
      }

      const keyboard = buildSongLinksKeyboard(song);

      await ctx.api.editMessageText(
        chatId,
        messageId,
        successMessage,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );

      logger.info('Telegram response sent', { chatId, messageId, jobId });
    } catch (error: unknown) {
      logger.error(`Music identification failed for job ${jobId}`, error);
      const userErrorMsg = formatErrorMessage(error);

      await ctx.api.editMessageText(
        chatId,
        messageId,
        userErrorMsg,
        {
          reply_markup: buildRetryKeyboard(jobId),
        }
      ).catch(() => {
        logger.error('Failed to edit callback message with error state');
      });
    }
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[\]]/g, '\\$&');
}

