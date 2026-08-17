export const COLORS = {
  WARN: "\x1b[33m%s\x1b[0m", // Yellow
  ERROR: "\x1b[31m%s\x1b[0m", // Red
};

export const logger = {
  // deno-lint-ignore no-explicit-any
  info: (...args: any[]) => console.log(...args),
  // deno-lint-ignore no-explicit-any
  warn: (...args: any[]) => console.warn(COLORS.WARN, ...args),
  // deno-lint-ignore no-explicit-any
  error: (...args: any[]) => console.error(COLORS.ERROR, ...args),
};