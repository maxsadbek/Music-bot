import { Context } from 'grammy';
import { logger } from '../utils/logger';
import {
  extractInstagramUrlFromText,
  validateAndNormalizeInstagramUrl,
} from '../validation/instagram';
import { getInstagramReel } from '../services/instagram';
import { identifySong, SongResult } from '../services/music-recognition';
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
 * Re-fetches fresh Instagram media URL if initial recognition fails due to expired CDN link,
 * then retries AudD music recognition.
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

    statusMsg = await ctx.reply('🎬 Reel received\n\n⏳ Getting the video...');

    const reelMedia = await getInstagramReel(normalizedUrl);

    const jobId = generateJobId();
    await saveReelJob({
      jobId,
      reelUrl: normalizedUrl,
      mediaUrl: reelMedia.mediaUrl,
      shortcode: reelMedia.id || shortcode,
      createdAt: Date.now(),
    });

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      '✅ Video found!',
      {
        reply_markup: buildFindMusicKeyboard(jobId),
      }
    );
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

      let successMessage = '🎵 *MUSIQА TOPILDI*\n\n';
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
