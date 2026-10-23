import * as fs from "@std/fs";
import * as path from "@std/path";

export const SECONV_RELEASES_URL = "https://github.com/SubtitleEdit/subtitleedit/releases";
export const SECONV_NOT_FOUND = `seconv was not found. Use the download button, or get it from ${SECONV_RELEASES_URL} and put it in lib/seconv/.`;

/** Everything the app runs lives under lib/ (relative to the working directory, like config.json). */
const LIB_DIR = path.resolve("lib");
/** Where the app-managed copy of seconv lives. */
export const SECONV_LIB_DIR = path.join(LIB_DIR, "seconv");
export const SECONV_BINARY = Deno.build.os === "windows" ? "seconv.exe" : "seconv";
/** The app-managed seconv's translation languages, saved by the installer (seconv has no command to list them). */
export const SECONV_LANGUAGES = path.join(SECONV_LIB_DIR, "languages.json");
/** llama.cpp for the llamacpp engine without a server URL: bin/, models/ and config.ini. */
export const LLAMACPP_DIR = path.join(LIB_DIR, "llama.cpp");
/** The llama.cpp build (llama-server and its libraries), replaced as a whole by updates, unlike models/ and config.ini. */
export const LLAMACPP_BIN = path.join(LLAMACPP_DIR, "bin");
export const LLAMACPP_SERVER = Deno.build.os === "windows" ? "llama-server.exe" : "llama-server";
export const LLAMACPP_MODELS = path.join(LLAMACPP_DIR, "models");
const LLAMACPP_CONFIG = path.join(LLAMACPP_DIR, "config.ini");
/**
 * seconv looks for llama-server in <its folder>/llama.cpp first, before Subtitle Edit's own install and the PATH; during
 * a run this is a link to LLAMACPP_BIN.
 */
const SECONV_LLAMACPP = path.join(SECONV_LIB_DIR, "llama.cpp");

/** Written to lib/llama.cpp/config.ini when it's missing; llama-server reads it because of seconvEnv. */
const DEFAULT_LLAMACPP_CONFIG = `; Read by llama-server at startup. seconv's own flags (model, host, port, ...) win over these.
[*]
; no chat web page and no /slots endpoint
ui = false
slots = false
; web pages on other sites can't read the server's responses
cors-origins = localhost
; never download anything
offline = true
`;

const isFile = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};

/** Finds the `seconv` executable in lib/seconv/, or null if there isn't one. */
export const findSeconv = (): string | null => {
  const local = path.join(SECONV_LIB_DIR, SECONV_BINARY);
  return isFile(local) ? local : null;
};

/** Finds llama-server in lib/llama.cpp/bin/, or null if there isn't one. */
export const findLlamaServer = (): string | null => {
  const local = path.join(LLAMACPP_BIN, LLAMACPP_SERVER);
  return isFile(local) ? local : null;
};

/**
 * Checks the llama.cpp in lib/llama.cpp/ that seconv will start, writes its config.ini if missing, and returns the full
 * path of the model to serve: `model` (a file in lib/llama.cpp/models/, ".gguf" optional), or the first one there.
 */
export const prepareLlamaCpp = (model: string): string => {
  if (!findLlamaServer()) {
    throw new Error(`llama.cpp was not found in ${LLAMACPP_BIN}. Download it with Tools → Update llama.cpp, or set a server URL.`);
  }
  if (!isFile(LLAMACPP_CONFIG)) {
    Deno.writeTextFileSync(LLAMACPP_CONFIG, DEFAULT_LLAMACPP_CONFIG);
  }

  if (model !== path.basename(model)) {
    throw new Error(`The model must be a file name in ${LLAMACPP_MODELS}, not a path.`);
  }
  const isModel = (name: string) => /\.gguf$/i.test(name) && !/^mmproj-|-mmproj\.gguf$/i.test(name); // skip vision projectors
  const file = model
    ? (/\.gguf$/i.test(model) ? model : `${model}.gguf`)
    : fs.existsSync(LLAMACPP_MODELS)
    ? [...Deno.readDirSync(LLAMACPP_MODELS)].map((e) => e.name).filter(isModel).sort()[0]
    : undefined;
  if (!file || !isFile(path.join(LLAMACPP_MODELS, file))) {
    throw new Error(file ? `Model ${file} was not found in ${LLAMACPP_MODELS}.` : `No .gguf model was found in ${LLAMACPP_MODELS}.`);
  }
  return path.join(LLAMACPP_MODELS, file);
};

/** Removes the link to lib/llama.cpp/bin from lib/seconv. Only the link goes; what it points to is never touched. */
export const unlinkLlamaCpp = () => {
  try {
    Deno.removeSync(SECONV_LLAMACPP, { recursive: true }); // also clears the empty models/ older versions let seconv create here
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};

/**
 * Links lib/seconv/llama.cpp to lib/llama.cpp/bin for a run, so that seconv uses it instead of Subtitle Edit's own
 * llama.cpp. A junction on Windows (no admin needed), a symlink elsewhere.
 */
export const linkLlamaCpp = () => {
  unlinkLlamaCpp();
  try {
    Deno.symlinkSync(LLAMACPP_BIN, SECONV_LLAMACPP, { type: "junction" });
  } catch {
    // No junctions on exFAT/FAT32: seconv then finds llama-server through the PATH from seconvEnv, which only comes
    // after Subtitle Edit's own llama.cpp
    const appData = Deno.env.get("APPDATA");
    const seLlamaCpp = appData && path.join(appData, "Subtitle Edit", "llama.cpp");
    if (seLlamaCpp && fs.existsSync(seLlamaCpp)) {
      throw new Error(`seconv would use Subtitle Edit's llama.cpp in ${seLlamaCpp} instead of ${LLAMACPP_BIN}. Move or delete it.`);
    }
  }
};

/**
 * The environment for seconv and the llama-server it starts, so that neither picks anything up from outside lib/:
 * - PATH is only lib/llama.cpp/bin: nothing from the system PATH, and seconv's fallback when the link can't be made
 * - llama-server reads LLAMA_* / HF_* / GGML_* variables (GGML_BACKEND_PATH even loads a library from anywhere), and
 *   config.ini from %PROGRAMDATA%\llama.cpp and %APPDATA%\llama.cpp (XDG_CONFIG_HOME/llama.cpp elsewhere): those point at
 *   lib/, so it reads lib/llama.cpp/config.ini
 * - CUDA builds would otherwise cache compiled kernels in %APPDATA%\NVIDIA\ComputeCache
 */
export const seconvEnv = (env: Record<string, string>): Record<string, string> => {
  const own: Record<string, string> = {
    PATH: LLAMACPP_BIN,
    APPDATA: LIB_DIR,
    PROGRAMDATA: LIB_DIR,
    XDG_CONFIG_HOME: LIB_DIR,
    CUDA_CACHE_DISABLE: "1",
  };
  // Windows names are case-insensitive ("Path"), so every spelling of the ones set here goes
  const kept = Object.entries(env).filter(([key]) => !/^(LLAMA|HF|GGML)_/i.test(key) && !(key.toUpperCase() in own));
  return { ...Object.fromEntries(kept), ...own };
};
