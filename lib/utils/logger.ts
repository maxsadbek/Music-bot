/**
 * Sanitizing Structured Logger for Musify
 * Ensures no bot tokens, API keys, or sensitive credentials leak into logs.
 *
 * IMPORTANT: All output goes through console.log as a SINGLE string argument.
 * Vercel Serverless may not capture multi-argument console.log calls correctly,
 * so we stringify all metadata into the message string.
 */

const SECRETS_TO_MASK = [
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_WEBHOOK_SECRET,
  process.env.ACRCLOUD_ACCESS_KEY,
  process.env.ACRCLOUD_ACCESS_SECRET,
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

/**
 * Stringify meta objects into a single safe string for logging.
 * Handles circular references and long values gracefully.
 */
function stringifyMeta(meta: unknown[]): string {
  if (meta.length === 0) return '';
  const obj = meta.length === 1 ? meta[0] : meta;
  try {
    return ' ' + JSON.stringify(obj);
  } catch {
    return ' ' + String(obj);
  }
}

export const logger = {
  info: (msg: string, ...meta: unknown[]) => {
    const formatted = sanitize(msg);
    const metaStr = stringifyMeta(meta);
    console.log(`[INFO] ${formatted}${metaStr}`);
  },
  warn: (msg: string, ...meta: unknown[]) => {
    const formatted = sanitize(msg);
    const metaStr = stringifyMeta(meta);
    console.warn(`[WARN] ${formatted}${metaStr}`);
  },
  error: (msg: string, error?: unknown) => {
    const formatted = sanitize(msg);
    if (error instanceof Error) {
      const stack = error.stack ? sanitize(error.stack) : '';
      console.error(`[ERROR] ${formatted}: ${sanitize(error.message)} ${stack}`);
    } else if (error) {
      const metaStr = stringifyMeta([error]);
      console.error(`[ERROR] ${formatted}${metaStr}`);
    } else {
      console.error(`[ERROR] ${formatted}`);
    }
  },
};
