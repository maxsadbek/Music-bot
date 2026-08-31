import { Context, InlineKeyboard, InputFile } from 'grammy';
import { logger } from '../utils/logger';
import {
  extractInstagramUrlFromText,
  validateAndNormalizeInstagramUrl,
} from '../validation/instagram';
import { getInstagramReel } from '../services/instagram';
import { downloadMediaBuffer, identifySong, SongResult } from '../services/music-recognition';
import { getSongAudio, AudioSourceError } from '../services/audio-source';
import { generateJobId, getReelJob, ReelJobData, saveReelJob } from '../services/cache';
import { checkRateLimit } from '../services/rate-limit';
import { buildGetSongKeyboard } from './keyboards';
import {
  formatErrorMessage,
  MusicNotFoundError,
  RateLimitError,
} from '../utils/errors';

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

  let caption = `🎵 ${title} \\- ${artist}`;

  const album = song.album ? escapeMarkdown(song.album) : undefined;
  const date = song.releaseDate ? formatReleaseDate(song.releaseDate) : undefined;

  if (album || date) {
    caption += '\n';
    if (album) caption += `\n💿 ${album}`;
    if (date) caption += `\n📅 ${date}`;
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

    // 3. Save job to cache (will be updated with song data after recognition)
    const jobId = generateJobId();
    const jobData: ReelJobData = {
      jobId,
      reelUrl: normalizedUrl,
      mediaUrl: reelMedia.mediaUrl,
      shortcode: reelMedia.id || shortcode,
      createdAt: Date.now(),
    };

    // 4. Perform ACRCloud music recognition
    let captionText = '🎵 Musiqa aniqlanmadi.';
    let keyboard: InlineKeyboard | undefined;

    try {
      const song = await identifySong(downloadedBuffer || reelMedia.mediaUrl);
      captionText = formatSongCaption(song);
      keyboard = buildGetSongKeyboard(jobId);

      // Store song info in cache for callback handler
      jobData.songTitle = song.title;
      jobData.songArtist = song.artist;
    } catch (musicErr) {
      if (musicErr instanceof MusicNotFoundError) {
        logger.info('No music recognized for reel', { shortcode });
      } else {
        logger.error('Music recognition failed for reel', musicErr);
      }
      captionText = '🎵 Musiqa aniqlanmadi.';
    }

    await saveReelJob(jobData);

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
 * Handles callback queries.
 *
 * "get_song:<jobId>" — Fetches the actual audio file and sends it to the user as a Telegram audio message.
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
    const jobId = callbackData.split(':')[1];
    await ctx.answerCallbackQuery();

    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (!chatId) return;

    try {
      const job = await getReelJob(jobId);

      if (!job || !job.songTitle || !job.songArtist) {
        await ctx.api.sendMessage(chatId, '⚠️ Qo‘shiq maʼlumotlari topilmadi. Reel linkini qayta yuboring.');
        return;
      }

      await ctx.api.sendMessage(chatId, '⏳ Qo‘shiq yuklanmoqda...');

      const audio = await getSongAudio(job.songTitle, job.songArtist);

      await ctx.api.sendAudio(chatId, new InputFile(audio.buffer, `${audio.title}.mp3`), {
        title: audio.title,
        performer: audio.artist,
        duration: audio.durationSeconds,
      });

      logger.info('Audio file sent to Telegram', { jobId, title: audio.title, artist: audio.artist });
    } catch (error: unknown) {
      logger.error('Failed to send audio for get_song callback', error);

      let userMsg = '⚠️ Qo‘shiqni yuklab bo‘lmadi. Keyinroq qayta urinib ko‘ring.';
      if (error instanceof AudioSourceError) {
        userMsg = '⚠️ Qo‘shiq topilmadi. Keyinroq qayta urinib ko‘ring.';
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
