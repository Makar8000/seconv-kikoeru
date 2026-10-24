import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.ts";
import { SECONV_LANGUAGES } from "../seconv/locate.ts";
import zeroGProfile from "./default-profiles/0g-private-computer.json" with { type: "json" };
import defaultConfig from "./default-profiles/default-config.json" with { type: "json" };
import openRouterProfile from "./default-profiles/openrouter.json" with { type: "json" };
import bundledLanguages from "./languages.json" with { type: "json" };

/**
 * A profile's settings, saved in `profiles/` (in the current working directory) as a .json file named after the profile.
 * See `default-profiles/default-config.json` for the settings of a new profile.
 *
 * SeConv options: https://subtitleedit.github.io/subtitleedit/reference/command-line.html
 * - `name`: the profile's name in the Profile menu
 * - `translateFrom`: if empty, auto-detect
 * - `engines`: one settings entry per translation engine (see `EngineConfig`); only the selected `translateEngine` is used
 * - `rjPath`: folder searched recursively for files to translate
 * - `subtitleExtensions`: file types to parse
 */
export type Config = {
  name: string;
  translateEngine: string;
  translateFrom: string;
  translateTo: string;
  engines: Record<string, EngineConfig>;
  rjPath: string;
  subtitleExtensions: string[];
};

/**
 * Settings that belong to a single translation engine.
 * - `model`: llamacpp: a Hugging Face file link or repository (downloaded into lib/llama.cpp/models), or a file name in
 *   that folder (the first one there when empty)
 * - `url`: llamacpp: a llama.cpp server already running there is used, else one is started on its port
 * - `apiKey`: only for openai-compatible and deepl (required for deepl)
 * - `useCustomPrompt`: if false, `prompt` is kept but not sent, so seconv uses its default prompt
 * - `prompt`: only for the LLM engines (llamacpp, openai-compatible); if empty, seconv's default
 * - `temperature`, `topP`, `topK`, `repeatPenalty`: llamacpp only, the sampling defaults of the llama-server this app
 *   starts (seconv sends none of its own when it's given a URL); a server that was already running keeps its own
 * - `additionalArgs`: extra args passed straight to seconv
 */
export type EngineConfig = {
  model: string;
  url: string;
  apiKey: string;
  useCustomPrompt: boolean;
  prompt: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  additionalArgs: string[];
};

/**
 * Languages offered for `--translate-from` / `--translate-to`, taken from Subtitle Edit's list (the LLM engines'
 * `ChatGptTranslate.ListLanguages`): the list the installer saved for the installed seconv, or the bundled
 * `languages.json` when there is none (seconv put in lib/seconv by hand, or the save failed). seconv accepts a code or an English
 * name; which languages are really supported depends on the engine, so other values can still be typed into a profile.
 * Mutated in place by `reloadLanguages`, so imports always see the current list.
 */
export const LANGUAGES: { name: string; code: string }[] = [];

export const reloadLanguages = () => {
  let list = bundledLanguages;
  try {
    const saved = JSON.parse(readFileSync(SECONV_LANGUAGES, "utf8"));
    if (!Array.isArray(saved)) {
      throw new Error("not a list");
    }
    list = saved;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Failed to read ${SECONV_LANGUAGES}, using the built-in language list. ${e}`);
    }
  }
  LANGUAGES.splice(0, LANGUAGES.length, ...list);
};
reloadLanguages();

const defaults: Config = defaultConfig;

/**
 * The `--translate-engine` values the app offers: one entry each in `default-config.json`. seconv takes more (see
 * https://subtitleedit.github.io/subtitleedit/reference/command-line.html), and one typed into a profile still works.
 */
export const TRANSLATE_ENGINES = Object.keys(defaults.engines);

/** One .json file per profile */
const PROFILES_DIR = path.resolve("profiles");
/** Settings of the app rather than of a profile: which profile is loaded */
const appPath = path.resolve("settings.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const list = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x)
    : [];
// The app's number fields send strings
const num = (v: unknown, integer = false) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && n >= 0 && (integer ? Number.isInteger(n) : Number.isFinite(n)) ? n : undefined;
};

const normalizeEngine = (raw: unknown, def?: EngineConfig): EngineConfig => {
  const input = isRecord(raw) ? raw : {};
  return {
    model: str(input.model) ?? def?.model ?? "",
    url: str(input.url) ?? def?.url ?? "",
    apiKey: str(input.apiKey) ?? def?.apiKey ?? "",
    useCustomPrompt: bool(input.useCustomPrompt) ?? def?.useCustomPrompt ?? false,
    prompt: str(input.prompt) ?? def?.prompt ?? "",
    // Only engines with default sampling (llamacpp) get any; for the rest these stay undefined and aren't saved
    temperature: num(input.temperature) ?? def?.temperature,
    topP: num(input.topP) ?? def?.topP,
    topK: num(input.topK, true) ?? def?.topK,
    repeatPenalty: num(input.repeatPenalty) ?? def?.repeatPenalty,
    additionalArgs: list(input.additionalArgs),
  };
};

/**
 * Builds a valid `Config` from untrusted input: wrong types / missing keys fall back to defaults, strings are trimmed.
 * A blank name falls back to `name`.
 */
const normalize = (raw: unknown, name = defaults.name): Config => {
  const input = isRecord(raw) ? raw : {};
  const result = structuredClone(defaults);

  // Blank values fall back to the default, except translateFrom where blank means auto-detect
  result.name = str(input.name) || name;
  result.translateEngine = str(input.translateEngine) || defaults.translateEngine;
  result.translateFrom = str(input.translateFrom) ?? defaults.translateFrom;
  result.translateTo = str(input.translateTo) || defaults.translateTo;
  result.rjPath = str(input.rjPath) || defaults.rjPath;
  const extensions = list(input.subtitleExtensions);
  result.subtitleExtensions = extensions.length ? extensions : defaults.subtitleExtensions;

  const engines: Record<string, unknown> = isRecord(input.engines) ? input.engines : {};
  // Every known engine gets an entry, plus any hand-typed engine that is selected or already configured
  const names = new Set([...TRANSLATE_ENGINES, ...Object.keys(engines), result.translateEngine]);
  result.engines = Object.fromEntries([...names].map((name) => [name, normalizeEngine(engines[name], defaults.engines[name])]));

  return result;
};

const fileStem = (file: string) => file.replace(/\.json$/i, "");

/** The profiles, sorted by name. One whose file has no name, or can't be read, goes by its file name. */
export const listProfiles = () => {
  const profiles: { file: string; name: string }[] = [];
  try {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      let name: string | undefined;
      try {
        const raw = JSON.parse(readFileSync(path.join(PROFILES_DIR, entry.name), "utf8"));
        name = isRecord(raw) ? str(raw.name) : undefined;
      } catch {
        /* loading it says what's wrong */
      }
      profiles.push({ file: entry.name, name: name || fileStem(entry.name) });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
};

const readProfile = (file: string): Config => {
  try {
    return normalize(JSON.parse(readFileSync(path.join(PROFILES_DIR, file), "utf8")), fileStem(file));
  } catch (e) {
    // Don't overwrite a profile the user may want to fix by hand
    logger.warn(`Failed to read the profile ${file}, using defaults. ${e}`);
    return normalize({}, fileStem(file));
  }
};

const writeProfile = (file: string, settings: Config) => {
  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(path.join(PROFILES_DIR, file), JSON.stringify(settings, null, 2));
};

const writeApp = (profile: string) => writeFileSync(appPath, JSON.stringify({ profile }, null, 2));

/**
 * The file for a profile named `name`: the name in kebab-case, stripped of everything but letters and digits ("Local (copy)"
 * is local-copy.json), with -2, -3, ... when another profile has that file. `own` is the profile's current file.
 */
const fileFor = (name: string, own = "") => {
  const kebab =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "profile";
  // Windows reserves these device names, whatever the extension
  const base = /^(con|prn|aux|nul|com\d|lpt\d)$/.test(kebab) ? `${kebab}-profile` : kebab;
  const taken = new Set(listProfiles().map((p) => p.file.toLowerCase()));
  taken.delete(own.toLowerCase());
  let file = `${base}.json`;
  for (let n = 2; taken.has(file); n++) {
    file = `${base}-${n}.json`;
  }
  return file;
};

/** Saves `settings` as a new profile, in the file its name gives, and returns that file. */
const createProfile = (settings: Config) => {
  const file = fileFor(settings.name);
  writeProfile(file, settings);
  return file;
};

/** `base`, or `base 2`, `base 3`, ... when a profile already has that name */
export const uniqueName = (base: string) => {
  const names = new Set(listProfiles().map((p) => p.name));
  let name = base;
  for (let n = 2; names.has(name); n++) {
    name = `${base} ${n}`;
  }
  return name;
};

/** The loaded profile's file in `profiles/` */
let profileFile = "";
export const currentProfile = () => profileFile;
/** Counts profile loads, but not renames, so the page can tell its form shows a profile that's no longer loaded */
let loads = 0;
export const profileLoads = () => loads;

/** Loads the profile settings.json names, else the first one; on a first launch, creates the default and OpenRouter profiles. */
const load = (): Config => {
  let wanted: unknown;
  try {
    wanted = JSON.parse(readFileSync(appPath, "utf8")).profile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Failed to read ${appPath}. ${e}`);
    }
  }

  const profiles = listProfiles();
  let file = profiles.find((p) => p.file === wanted)?.file ?? profiles[0]?.file;
  if (!file) {
    file = createProfile(normalize({}));
    createProfile(normalize(openRouterProfile));
    createProfile(normalize(zeroGProfile));
  }
  if (file !== wanted) {
    writeApp(file);
  }
  profileFile = file;
  return readProfile(file);
};

/** The loaded profile's settings. Mutated in place, so imports always see current values. */
export const config: Config = load();

/** Settings of the currently selected translation engine. */
export const engineConfig = (): EngineConfig => config.engines[config.translateEngine];

/** Validates `raw`, applies it to the shared `config`, and saves it to the loaded profile. A blank name keeps the current one. */
export const updateConfig = (raw: unknown): Config => {
  Object.assign(config, normalize(raw, config.name));
  writeProfile(profileFile, config);
  return config;
};

const select = (file: string, settings: Config) => {
  Object.assign(config, settings);
  profileFile = file;
  loads++;
  writeApp(file);
};

/** Loads another profile from `profiles/`. */
export const switchProfile = (file: string) => {
  if (!listProfiles().some((p) => p.file === file)) {
    throw new Error(`There is no profile ${file} in ${PROFILES_DIR}.`);
  }
  select(file, readProfile(file));
};

const addProfile = (settings: Config) => select(createProfile(settings), settings);

/** Creates a profile with the default settings and loads it. */
export const newProfile = (name: string) => addProfile(normalize({}, name));

/** Copies the loaded profile into a new one and loads it. */
export const duplicateProfile = (name: string) => addProfile({ ...structuredClone(config), name });

/** Renames the loaded profile, and its file to match. */
export const renameProfile = (name: string) => {
  const file = fileFor(name, profileFile);
  if (file !== profileFile) {
    renameSync(path.join(PROFILES_DIR, profileFile), path.join(PROFILES_DIR, file));
    profileFile = file;
    writeApp(file);
  }
  updateConfig({ ...config, name });
};

/** Deletes the loaded profile's file and loads the first profile left. */
export const deleteProfile = () => {
  const rest = listProfiles().filter((p) => p.file !== profileFile);
  if (!rest.length) {
    throw new Error("The last profile can't be deleted.");
  }
  rmSync(path.join(PROFILES_DIR, profileFile));
  switchProfile(rest[0].file);
};
