import { Bot } from 'grammy';
import { logger } from '../utils/logger';
import {
  handleAbout,
  handleCallbackQuery,
  handleHelp,
  handleStart,
  handleTextMessage,
} from './handlers';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  logger.warn('TELEGRAM_BOT_TOKEN is not configured in environment variables.');
}

/**
 * Creates and configures the grammY Bot instance
 */
export function createBot(): Bot {
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to instantiate Telegram bot.');
  }

  const bot = new Bot(token);

  // Global Error Handler
  bot.catch((err) => {
    logger.error(`Unhandled bot error in update ${err.ctx.update.update_id}:`, err.error);
  });

  // Register bot commands
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('about', handleAbout);

  // Register text message handler (for Instagram URLs)
  bot.on('message:text', handleTextMessage);

  // Register inline button callback queries
  bot.on('callback_query:data', handleCallbackQuery);

  return bot;
}

/**
 * Lazy singleton instance for serverless function reuse.
 * The initialization promise is cached so bot.init() is only called
 * once per cold start — subsequent requests reuse the same instance.
 */
let botInstance: Bot | null = null;
let botInitPromise: Promise<Bot> | null = null;

export async function getBot(): Promise<Bot> {
  if (botInstance) {
    return botInstance;
  }

  if (!botInitPromise) {
    botInitPromise = (async () => {
      const bot = createBot();
      await bot.init();
      logger.info('[Bot] Bot initialized successfully', {
        username: bot.botInfo.username,
      });
      return bot;
    })().catch((err) => {
      // Reset so a future call can retry on cold start
      botInitPromise = null;
      throw err;
    });
  }

  botInstance = await botInitPromise;
  return botInstance;
}
