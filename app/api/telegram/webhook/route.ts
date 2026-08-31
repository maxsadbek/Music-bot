import { webhookCallback } from 'grammy';
import { getBot } from '../../../../lib/bot';
import { logger } from '../../../../lib/utils/logger';

export const dynamic = 'force-dynamic';

/**
 * Configure maximum execution duration for Vercel Serverless Functions.
 * Necessary because Instagram media retrieval (up to 12s timeout) and AudD
 * music recognition API (up to 20s timeout) can take upwards of 30+ seconds.
 * Note: Setting maxDuration > 10s requires Vercel Pro plan.
 */
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    // 1. Validate Secret Token if TELEGRAM_WEBHOOK_SECRET environment variable is set
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');
      if (secretHeader !== expectedSecret) {
        logger.warn('Unauthorized webhook request received (invalid secret header)');
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // 2. Obtain Bot instance & handle webhook update
    const bot = getBot();
    const handleUpdate = webhookCallback(bot, 'std/http');
    return await handleUpdate(req);
  } catch (error) {
    logger.error('Error executing webhook handler', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: 'active',
      name: 'Musify Telegram Bot Webhook Endpoint',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
