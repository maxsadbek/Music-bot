import { getBot } from '../../../../lib/bot';
import { logger } from '../../../../lib/utils/logger';

export const dynamic = 'force-dynamic';

/**
 * Maximum execution duration for Vercel Serverless Functions.
 * Covers: bot.init() (cold start ~500ms) + handleUpdate
 * (Instagram download ~15s + ACRCloud ~3s + Telegram upload ~5s).
 */
export const maxDuration = 60;

/**
 * POST /api/telegram/webhook
 *
 * Architecture:
 * 1. Validate webhook secret (<1ms)
 * 2. Parse the raw Telegram update JSON (<5ms)
 * 3. Initialize bot via getBot() — bot.init() called once per cold start
 * 4. Await bot.handleUpdate(update) — processes the full update inline
 * 5. Return HTTP 200 to Telegram AFTER processing completes
 *
 * With maxDuration = 60, Vercel keeps the function alive for up to 60s.
 * This is enough for Instagram download + music recognition + video send.
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
      return new Response('OK', { status: 200 });
    }

    // ── 3. Initialize bot & process update BEFORE returning 200 ──────
    //
    // getBot() returns a cached singleton. On cold start it calls
    // bot.init() (Telegram getMe) once; subsequent invocations reuse
    // the same initialized instance.
    //
    // bot.handleUpdate() dispatches to registered handlers (start,
    // text messages, callbacks) and awaits each one. This runs the
    // full update flow inline — no detached promises.
    const start = Date.now();
    try {
      const bot = await getBot();
      await bot.handleUpdate(update);
      logger.info('[Webhook] Update processed', {
        duration: `${Date.now() - start}ms`,
        type: update.message ? 'message'
          : update.callback_query ? 'callback_query'
          : update.inline_query ? 'inline_query'
          : 'other',
      });
    } catch (error) {
      logger.error('[Webhook] Update processing failed', error);
      // Fall through to return 200 — prevents Telegram retries.
      // The error is already logged; Telegram will retry if the
      // update wasn't acknowledged by the handler.
    }

    // ── 4. Return 200 to Telegram ────────────────────────────────────
    return new Response('OK', { status: 200 });
  } catch (error) {
    logger.error('[Webhook] Error in webhook handler', error);
    // Return 200 even on unexpected errors to prevent Telegram retries
    return new Response('OK', { status: 200 });
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
      },
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
    },
  );
}
