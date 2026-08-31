import { webhookCallback } from 'grammy';
import { getBot } from '../../../../lib/bot';
import { logger } from '../../../../lib/utils/logger';

export const dynamic = 'force-dynamic';

/**
 * Configure maximum execution duration for Vercel Serverless Functions.
 * Necessary because Instagram media retrieval (up to 12s timeout) and ACRCloud
 * music recognition API (up to 20s timeout) can take upwards of 30+ seconds.
 * Note: Setting maxDuration > 10s requires Vercel Pro plan.
 */
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    // 1. Validate Secret Token if TELEGRAM_WEBHOOK_SECRET environment variable is set
    //    .trim() guards against accidental whitespace/newlines in the env var.
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const secretConfigured = Boolean(expectedSecret && expectedSecret.length > 0);
    const receivedSecret = req.headers.get('x-telegram-bot-api-secret-token')?.trim();
    const secretHeaderPresent = Boolean(receivedSecret && receivedSecret.length > 0);

    logger.info(
      `[Webhook] Secret configured: ${secretConfigured}, Header present: ${secretHeaderPresent}`,
    );

    if (secretConfigured) {
      if (!secretHeaderPresent) {
        logger.warn(
          '[Webhook] Request missing X-Telegram-Bot-Api-Secret-Token header. '
          + 'Telegram may not have been registered with a secret_token. '
          + 'Re-register via: GET /api/telegram/webhook?action=setup',
        );
        return new Response('Unauthorized', { status: 401 });
      }
      if (receivedSecret !== expectedSecret) {
        logger.warn(
          '[Webhook] Secret mismatch — TELEGRAM_WEBHOOK_SECRET env var value '
          + '(length ' + (expectedSecret?.length ?? 0) + ') does not match '
          + 'the secret_token Telegram is sending (length ' + (receivedSecret?.length ?? 0) + '). '
          + 'Re-register via: GET /api/telegram/webhook?action=setup',
        );
        return new Response('Unauthorized', { status: 401 });
      }
      logger.info('[Webhook] Secret validation passed');
    } else {
      logger.warn(
        '[Webhook] TELEGRAM_WEBHOOK_SECRET is not set — webhook is running WITHOUT secret validation. '
        + 'This is insecure. Set the env var and re-register.',
      );
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

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // GET /api/telegram/webhook?action=status → status check
  if (action === 'status') {
    const secretConfigured = Boolean(
      process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TELEGRAM_WEBHOOK_SECRET.length > 0,
    );
    return new Response(
      JSON.stringify({
        status: 'active',
        name: 'Musify Telegram Bot Webhook Endpoint',
        secretConfigured,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // GET /api/telegram/webhook?action=setup → re-register webhook with Telegram
  if (action === 'setup') {
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      // .trim() matches the validation in POST handler
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

      if (!botToken) {
        return new Response(
          JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN is not configured' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Determine the webhook URL from the request
      const webhookUrl = `${url.origin}/api/telegram/webhook`;

      const body: Record<string, unknown> = {
        url: webhookUrl,
      };

      // Only include secret_token if the env var is set
      if (webhookSecret && webhookSecret.length > 0) {
        body.secret_token = webhookSecret;
      }

      logger.info(`[Webhook Setup] Registering webhook URL: ${webhookUrl}`);

      const tgResponse = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      const result = await tgResponse.json();

      if (!tgResponse.ok || !(result as { ok?: boolean }).ok) {
        logger.error('[Webhook Setup] Telegram setWebhook failed', result);
        return new Response(
          JSON.stringify({ error: 'setWebhook failed', details: result }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
      }

      logger.info('[Webhook Setup] Webhook registered successfully');
      return new Response(
        JSON.stringify({
          success: true,
          webhookUrl,
          secretConfigured: Boolean(webhookSecret && webhookSecret.length > 0),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } catch (error) {
      logger.error('[Webhook Setup] Failed to register webhook', error);
      return new Response(
        JSON.stringify({ error: 'Setup failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // Default GET response
  return new Response(
    JSON.stringify({
      status: 'active',
      name: 'Musify Telegram Bot Webhook Endpoint',
      timestamp: new Date().toISOString(),
      usage: {
        status: 'GET /api/telegram/webhook?action=status',
        setup: 'GET /api/telegram/webhook?action=setup',
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
