import { getBot } from '../../../../lib/bot';
import { logger } from '../../../../lib/utils/logger';

export const dynamic = 'force-dynamic';

/**
 * Configure maximum execution duration for Vercel Serverless Functions.
 * The webhook returns 200 immediately; this duration applies to background processing.
 */
export const maxDuration = 60;

/**
 * POST /api/telegram/webhook
 *
 * Architecture:
 * 1. Validate webhook secret (fast, <1ms)
 * 2. Parse the raw Telegram update JSON (fast, <5ms)
 * 3. Return HTTP 200 to Telegram IMMEDIATELY — prevents retries
 * 4. Process the update in a detached promise (runs up to maxDuration)
 *
 * Telegram retries the webhook if it doesn't get a response within ~10s.
 * All long-running work (Instagram download, ACRCloud, video upload) happens
 * in the background AFTER the response is sent.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    // ── 1. Validate Secret Token ──────────────────────────────────────
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const secretConfigured = Boolean(expectedSecret && expectedSecret.length > 0);
    const receivedSecret = req.headers.get('x-telegram-bot-api-secret-token')?.trim();
    const secretHeaderPresent = Boolean(receivedSecret && receivedSecret.length > 0);

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
    }

    // ── 2. Parse the update body (fast, <5ms) ────────────────────────
    const update = await req.json();

    // Quick sanity check: is this a valid Telegram update?
    if (!update || typeof update.update_id !== 'number') {
      logger.warn('[Webhook] Received non-Telegram update body');
      return new Response('OK', { status: 200 }); // Still 200 to prevent retries
    }

    // ── 3. Return 200 to Telegram IMMEDIATELY ────────────────────────
    //    Long-running processing happens in the detached promise below.
    //    Vercel serverless functions continue running after the response
    //    is sent, up to maxDuration (60s).

    processUpdateInBackground(update).catch((err) => {
      logger.error('[Webhook] Background processing failed', err);
    });

    return new Response('OK', { status: 200 });
  } catch (error) {
    logger.error('[Webhook] Error in webhook handler', error);
    // Return 200 even on error to prevent Telegram retries
    return new Response('OK', { status: 200 });
  }
}

/**
 * Processes a Telegram update in the background.
 * Called from a detached promise — errors are caught by the caller.
 *
 * On Vercel, the serverless function continues executing after the HTTP
 * response has been sent. The function stays alive for up to `maxDuration`.
 */
async function processUpdateInBackground(update: Record<string, unknown>): Promise<void> {
  const start = Date.now();
  try {
    const bot = await getBot();
    await bot.handleUpdate(update as any);
    logger.info('[Webhook] Update processed', {
      duration: `${Date.now() - start}ms`,
      type: update.message ? 'message'
        : update.callback_query ? 'callback_query'
        : update.inline_query ? 'inline_query'
        : 'other',
    });
  } catch (error) {
    logger.error('[Webhook] Update processing failed', error);
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
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

      if (!botToken) {
        return new Response(
          JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN is not configured' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const webhookUrl = `${url.origin}/api/telegram/webhook`;

      const body: Record<string, unknown> = {
        url: webhookUrl,
      };

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
