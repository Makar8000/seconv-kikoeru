import { logger } from "../logger.ts";

const INTERVAL = 10_000;

/** Logs `text` with the time elapsed every 10 seconds, so a long step shows it's alive. Returns the function that stops it. */
export const heartbeat = (text: string) => {
  const startedAt = Date.now();
  const timer = setInterval(() => logger.info(`${text} (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`), INTERVAL);
  return () => clearInterval(timer);
};
