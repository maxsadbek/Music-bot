import { Context, InlineKeyboard, InputFile } from 'grammy';
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
  buildGetSongKeyboard,
  buildRetryKeyboard,
} from './keyboards';
import {
  formatErrorMessage,
  MusicNotFoundError,
  RateLimitError,
} from '../utils/errors';

/**
 * Formats song metadata into minimal, premium Telegram video caption.
 */
export function formatSongCaption(song: SongResult): string {
  const title = escapeMarkdown(song.title);
  const artist = escapeMarkdown(song.artist);
  const album = song.album ? escapeMarkdown(song.album) : undefined;
  const year = song.releaseDate ? song.releaseDate.slice(0, 4) : undefined;

  let caption = `🎵 *${title}*\n   ${artist}`;
  if (album || year) {
    caption += `\n\n━━━━━━━━━━━━━━━━━━`;
    if (album) caption += `\n💿 ${album}`;
    if (year) caption += `\n📅 ${year}`;
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
    '3. Musify qo‘shiqni aniqlaydi.';

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

    // Send temporary status message while fetching & recognizing
    statusMsg = await ctx.reply('⏳ Video va musiqa yuklanmoqda...');

    // 1. Fetch direct video media URL from SocialKit
    const reelMedia = await getInstagramReel(normalizedUrl);

    // 2. Pre-download media buffer once to reuse for both Telegram upload fallback and ACRCloud recognition
    let downloadedBuffer: Buffer | undefined;
    try {
      downloadedBuffer = await downloadMediaBuffer(reelMedia.mediaUrl);
    } catch (downloadErr) {
      logger.warn('Pre-downloading media buffer failed, fallback to URL download for recognition', downloadErr);
    }

    // 3. Save job to cache
    const jobId = generateJobId();
    await saveReelJob({
      jobId,
      reelUrl: normalizedUrl,
      mediaUrl: reelMedia.mediaUrl,
      shortcode: reelMedia.id || shortcode,
      createdAt: Date.now(),
    });

    // 4. Perform ACRCloud music recognition
    let captionText = '🎵 Musiqa aniqlanmadi.';
    let keyboard: InlineKeyboard | undefined;

    try {
      const song = await identifySong(downloadedBuffer || reelMedia.mediaUrl);
      captionText = formatSongCaption(song);
      keyboard = buildGetSongKeyboard(jobId);
    } catch (musicErr) {
      if (musicErr instanceof MusicNotFoundError) {
        logger.info('No music recognized for reel', { shortcode });
        captionText = '🎵 Musiqa aniqlanmadi.';
      } else {
        logger.error('Music recognition failed for reel', musicErr);
        captionText = '🎵 Musiqa aniqlanmadi.';
      }
    }

    // 5. Send ONE video message with caption and inline keyboard
    const videoSent = await sendReelVideoToTelegram(
      ctx,
      reelMedia.mediaUrl,
      reelMedia.id || shortcode,
      captionText,
      keyboard,
      downloadedBuffer
    );

    if (!videoSent) {
      logger.error('Telegram video send failed');
      throw new Error('Telegram video send failed');
    }

    // 6. Clean up temporary status message to leave ONLY the single Video message
    if (statusMsg && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }

    logger.info('Telegram single video response sent successfully', { jobId });
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
 * Handles callback queries (e.g. "get_song:<jobId>")
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

  if (callbackData.startsWith('get_song:')) {
    await ctx.answerCallbackQuery({
      text: '🎧 Qo‘shiqni yuklab olish funksiyasi tez orada ishga tushadi!',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`\[\]]/g, '\\$&');
}


