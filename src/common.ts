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

export function getEnv(name: string, defaultValue: string): string;
export function getEnv(name: string, defaultValue: string[]): string[];
export function getEnv(name: string, defaultValue: string | string[]): string | string[] {
  const raw = Deno.env.get(name);
  const hasValue = raw !== undefined && raw.trim().length > 0;

  if (Array.isArray(defaultValue)) {
    if (!hasValue) {
      return defaultValue;
    }

    const list = raw!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return list.length ? list : defaultValue;
  }

  return hasValue ? raw! : defaultValue;
}

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
