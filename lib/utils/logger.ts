/**
 * Sanitizing Structured Logger for Musify
 * Ensures no bot tokens, API keys, or sensitive credentials leak into logs.
 */

const SECRETS_TO_MASK = [
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_WEBHOOK_SECRET,
  process.env.AUDD_API_TOKEN,
  process.env.INSTAGRAM_API_KEY,
  process.env.REDIS_URL,
  process.env.UPSTASH_REDIS_REST_TOKEN,
].filter((secret): secret is string => Boolean(secret && secret.length > 3));

function sanitize(message: string): string {
  let sanitized = message;
  for (const secret of SECRETS_TO_MASK) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized;
}

export const logger = {
  info: (msg: string, ...meta: unknown[]) => {
    const formatted = sanitize(msg);
    if (meta.length > 0) {
      console.log(`[INFO] ${formatted}`, ...meta);
    } else {
      console.log(`[INFO] ${formatted}`);
    }
  },
  warn: (msg: string, ...meta: unknown[]) => {
    const formatted = sanitize(msg);
    if (meta.length > 0) {
      console.warn(`[WARN] ${formatted}`, ...meta);
    } else {
      console.warn(`[WARN] ${formatted}`);
    }
  },
  error: (msg: string, error?: unknown) => {
    const formatted = sanitize(msg);
    if (error instanceof Error) {
      console.error(`[ERROR] ${formatted}: ${sanitize(error.message)}`, error.stack ? sanitize(error.stack) : '');
    } else if (error) {
      console.error(`[ERROR] ${formatted}`, error);
    } else {
      console.error(`[ERROR] ${formatted}`);
    }
  },
};
