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
 * Lazy singleton instance for serverless function reuse
 */
let botInstance: Bot | null = null;

export function getBot(): Bot {
  if (!botInstance) {
    botInstance = createBot();
  }
  return botInstance;
}
