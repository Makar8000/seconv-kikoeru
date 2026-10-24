const COLORS = {
  WARN: "\x1b[33m%s\x1b[0m", // Yellow
  ERROR: "\x1b[31m%s\x1b[0m", // Red
};

const MAX_ENTRIES = 2000;

export type LogEntry = { id: number; level: "info" | "warn" | "error"; text: string };

const entries: LogEntry[] = [];
let nextId = 1;

// deno-lint-ignore no-explicit-any
const record = (level: LogEntry["level"], args: any[]) => {
  const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : Deno.inspect(a))).join(" ");
  entries.push({ id: nextId++, level, text });
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
};

/** Returns buffered log entries newer than `id` (use 0 for all), for display in the UI. */
export const getLogsSince = (id: number): LogEntry[] => entries.filter((e) => e.id > id);

/** Simple console logger with color-highlighted warning/error output. */
export const logger = {
  // deno-lint-ignore no-explicit-any
  info: (...args: any[]) => (record("info", args), console.log(...args)),
  // deno-lint-ignore no-explicit-any
  warn: (...args: any[]) => (record("warn", args), console.warn(COLORS.WARN, ...args)),
  // deno-lint-ignore no-explicit-any
  error: (...args: any[]) => (record("error", args), console.error(COLORS.ERROR, ...args)),
};
