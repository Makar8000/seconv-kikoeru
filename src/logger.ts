const COLORS = {
  WARN: "\x1b[33m%s\x1b[0m", // Yellow
  ERROR: "\x1b[31m%s\x1b[0m", // Red
};

const MAX_ENTRIES = 2000;

/** `time`: ms since the epoch, shown as a clock time in the page's console */
export type LogEntry = { id: number; level: "info" | "warn" | "error"; text: string; time: number };

const entries: LogEntry[] = [];
let nextId = 1;

const record = (level: LogEntry["level"], args: unknown[]) => {
  const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : Bun.inspect(a))).join(" ");
  entries.push({ id: nextId++, level, text, time: Date.now() });
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
};

/** Returns buffered log entries newer than `id` (use 0 for all), for display in the UI. */
export const getLogsSince = (id: number): LogEntry[] => entries.filter((e) => e.id > id);

/** Simple console logger with color-highlighted warning/error output. */
export const logger = {
  info: (...args: unknown[]) => {
    record("info", args);
    console.log(...args);
  },
  warn: (...args: unknown[]) => {
    record("warn", args);
    console.warn(COLORS.WARN, ...args);
  },
  error: (...args: unknown[]) => {
    record("error", args);
    console.error(COLORS.ERROR, ...args);
  },
};
