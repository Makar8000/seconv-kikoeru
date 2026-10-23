import * as path from "@std/path";
import { logger } from "../logger.ts";
import defaultConfig from "./default-config.json" with { type: "json" };
import languages from "./languages.json" with { type: "json" };

/**
 * Application configuration, persisted to `config.json` (in the current working directory).
 * See `default-config.json` for the defaults used when `config.json` doesn't exist yet.
 *
 * SeConv options: https://subtitleedit.github.io/subtitleedit/reference/command-line.html
 * - `translateFrom`: if empty, auto-detect
 * - `engines`: one settings entry per translation engine (see `EngineConfig`); only the selected `translateEngine` is used
 * - `rjPath`: folder searched recursively for files to translate
 * - `subtitleExtensions`: file types to parse
 */
export type Config = {
  translateEngine: string;
  translateFrom: string;
  translateTo: string;
  engines: Record<string, EngineConfig>;
  rjPath: string;
  subtitleExtensions: string[];
};

/**
 * Settings that belong to a single translation engine.
 * - `model`: if empty, seconv uses the first available model
 * - `url`: if empty (llamacpp), seconv starts & stops a server itself
 * - `apiKey`: only for openai-compatible and deepl (required for deepl)
 * - `useCustomPrompt`: if false, `prompt` is kept but not sent, so seconv uses its default prompt
 * - `prompt`: only for the LLM engines (llamacpp, ollama, lmstudio, openai-compatible); if empty, seconv's default
 * - `additionalArgs`: extra args passed straight to seconv
 */
export type EngineConfig = { model: string; url: string; apiKey: string; useCustomPrompt: boolean; prompt: string; additionalArgs: string[] };

/**
 * Languages offered for `--translate-from` / `--translate-to`, taken from Subtitle Edit's list (the LLM engines'
 * `ChatGptTranslate.ListLanguages`). seconv accepts a code or an English name; which languages are really supported
 * depends on the engine, so other values can still be typed into config.json.
 */
export const LANGUAGES: { name: string; code: string }[] = languages;

const defaults: Config = defaultConfig;

/**
 * Valid `--translate-engine` values. The list lives in `default-config.json` (one entry per engine), taken from the SeConv docs
 * because seconv has no command to list them: https://subtitleedit.github.io/subtitleedit/reference/command-line.html
 */
export const TRANSLATE_ENGINES = Object.keys(defaults.engines);

export const configPath = path.resolve("config.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => x) : []);

const normalizeEngine = (raw: unknown, def?: EngineConfig): EngineConfig => {
  const input = isRecord(raw) ? raw : {};
  return {
    model: str(input.model) ?? def?.model ?? "",
    url: str(input.url) ?? def?.url ?? "",
    apiKey: str(input.apiKey) ?? def?.apiKey ?? "",
    useCustomPrompt: bool(input.useCustomPrompt) ?? def?.useCustomPrompt ?? false,
    prompt: str(input.prompt) ?? def?.prompt ?? "",
    additionalArgs: list(input.additionalArgs),
  };
};

/** Builds a valid `Config` from untrusted input: wrong types / missing keys fall back to defaults, strings are trimmed. */
const normalize = (raw: unknown): Config => {
  const input = isRecord(raw) ? raw : {};
  const result = structuredClone(defaults);

  // Blank values fall back to the default, except translateFrom where blank means auto-detect
  result.translateEngine = str(input.translateEngine) || defaults.translateEngine;
  result.translateFrom = str(input.translateFrom) ?? defaults.translateFrom;
  result.translateTo = str(input.translateTo) || defaults.translateTo;
  result.rjPath = str(input.rjPath) || defaults.rjPath;
  const extensions = list(input.subtitleExtensions);
  result.subtitleExtensions = extensions.length ? extensions : defaults.subtitleExtensions;

  // Config files from before per-engine settings kept one model/url/args set; it belonged to the engine that was selected
  const engines: Record<string, unknown> = isRecord(input.engines) ? { ...input.engines } : {};
  if (!isRecord(input.engines) && ("translateModel" in input || "translateUrl" in input || "seconvAdditionalArgs" in input)) {
    engines[result.translateEngine] = { model: input.translateModel, url: input.translateUrl, additionalArgs: input.seconvAdditionalArgs };
  }

  // Every known engine gets an entry, plus any hand-typed engine that is selected or already configured
  const names = new Set([...TRANSLATE_ENGINES, ...Object.keys(engines), result.translateEngine]);
  result.engines = Object.fromEntries([...names].map((name) => [name, normalizeEngine(engines[name], defaults.engines[name])]));

  return result;
};

const load = (): Config => {
  try {
    return normalize(JSON.parse(Deno.readTextFileSync(configPath)));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      const initial = normalize({});
      Deno.writeTextFileSync(configPath, JSON.stringify(initial, null, 2));
      return initial;
    }
    // Don't overwrite a config the user may want to fix by hand
    logger.warn(`Failed to read ${configPath}, using defaults. ${e}`);
    return normalize({});
  }
};

/** Shared, typed configuration. Mutated in place by `updateConfig`, so imports always see current values. */
export const config: Config = load();

/** Settings of the currently selected translation engine. */
export const engineConfig = (): EngineConfig => config.engines[config.translateEngine];

/** Validates `raw`, applies it to the shared `config`, and persists it to `config.json`. */
export const updateConfig = (raw: unknown): Config => {
  Object.assign(config, normalize(raw));
  Deno.writeTextFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
};
