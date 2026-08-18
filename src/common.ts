import * as fs from "@std/fs";

export const COLORS = {
  WARN: "\x1b[33m%s\x1b[0m", // Yellow
  ERROR: "\x1b[31m%s\x1b[0m", // Red
};

export type TranslationResult = {
  filesGlob: string;
  ext: string;
};

export const logger = {
  // deno-lint-ignore no-explicit-any
  info: (...args: any[]) => console.log(...args),
  // deno-lint-ignore no-explicit-any
  warn: (...args: any[]) => console.warn(COLORS.WARN, ...args),
  // deno-lint-ignore no-explicit-any
  error: (...args: any[]) => console.error(COLORS.ERROR, ...args),
};

export const loadFailedTranslations = (path: string): TranslationResult[] => {
  if (!fs.existsSync(path)) {
    return [];
  }

  try {
    const data = Deno.readTextFileSync(path);
    const json = JSON.parse(data);
    if (Array.isArray(json)) {
      return json.filter((f) => f?.filesGlob && f?.ext);
    }
  } catch {
    logger.warn(`Failed to parse ${path}`);
  }

  return [];
};
