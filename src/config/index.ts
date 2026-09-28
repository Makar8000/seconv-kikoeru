/**
 * Reads an environment variable, falling back to `defaultValue` when the variable is unset,
 * empty, or contains only whitespace.
 *
 * If `defaultValue` is an array, the raw value is split on `,`, each entry is trimmed, and
 * empty entries are dropped; if the result is empty, `defaultValue` is returned instead.
 */
function getEnv(name: string, defaultValue: string): string;
function getEnv(name: string, defaultValue: string[]): string[];
function getEnv(name: string, defaultValue: string | string[]): string | string[] {
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

/** Centralized, typed application configuration, sourced from environment variables (see `.env.example`). */
export const config = {
  rjPath: getEnv("RJ_PATH", "./queue"),
  seconvPath: getEnv("SECONV_PATH", "seconv"),
  translateEngine: getEnv("TRANSLATE_ENGINE", "llamacpp"),
  translateModel: getEnv("TRANSLATE_MODEL", ""),
  translateUrl: getEnv("TRANSLATE_URL", ""),
  translateFrom: getEnv("TRANSLATE_FROM", ""),
  translateTo: getEnv("TRANSLATE_TO", "en"),
  seconvAdditionalArgs: getEnv("SECONV_ADDITIONAL_ARGS", []),
  subtitleExtensions: getEnv("SUBTITLE_EXTENSIONS", ["lrc", "srt", "vtt"]),
};
