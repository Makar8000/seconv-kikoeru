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
/** llama.cpp for the llamacpp engine: bin/, models/ and config.ini. */
export const LLAMACPP_DIR = path.join(LIB_DIR, "llama.cpp");
/** The llama.cpp build (llama-server and its libraries), replaced as a whole by updates, unlike models/ and config.ini. */
export const LLAMACPP_BIN = path.join(LLAMACPP_DIR, "bin");
export const LLAMACPP_SERVER = Deno.build.os === "windows" ? "llama-server.exe" : "llama-server";
/** llama.cpp's command-line tool, used for its model downloader. */
export const LLAMACPP_TOOL = Deno.build.os === "windows" ? "llama.exe" : "llama";
export const LLAMACPP_MODELS = path.join(LLAMACPP_DIR, "models");
const LLAMACPP_CONFIG = path.join(LLAMACPP_DIR, "config.ini");

/** Written to lib/llama.cpp/config.ini when it's missing; llama-server reads it because of llamaCppEnv. */
const DEFAULT_LLAMACPP_CONFIG = `; Read by llama-server at startup. The app's own flags (model, host, port, ...) win over these.
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

/** Finds `model` (a file in lib/llama.cpp/models/, ".gguf" optional), or the first model there when it's empty. */
export const findModel = (model: string): string => {
  if (model !== path.basename(model)) {
    throw new Error(`The model must be a Hugging Face model or a file name in ${LLAMACPP_MODELS}, not a path.`);
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

/** Writes lib/llama.cpp/config.ini when it's missing. */
export const writeLlamaCppConfig = () => {
  if (!isFile(LLAMACPP_CONFIG)) {
    Deno.writeTextFileSync(LLAMACPP_CONFIG, DEFAULT_LLAMACPP_CONFIG);
  }
};

/**
 * The environment for llama.cpp's programs, so that they pick nothing up from outside lib/:
 * - PATH is only lib/llama.cpp/bin: no libraries from the system PATH
 * - llama.cpp reads LLAMA_* / HF_* / GGML_* variables (GGML_BACKEND_PATH even loads a library from anywhere), and
 *   config.ini from %PROGRAMDATA%\llama.cpp and %APPDATA%\llama.cpp (XDG_CONFIG_HOME/llama.cpp elsewhere): those point at
 *   `configHome`, by default lib/, so llama-server reads lib/llama.cpp/config.ini
 * - CUDA builds would otherwise cache compiled kernels in %APPDATA%\NVIDIA\ComputeCache
 */
export const llamaCppEnv = (env: Record<string, string>, configHome = LIB_DIR): Record<string, string> => {
  const own: Record<string, string> = {
    PATH: LLAMACPP_BIN,
    APPDATA: configHome,
    PROGRAMDATA: configHome,
    XDG_CONFIG_HOME: configHome,
    CUDA_CACHE_DISABLE: "1",
  };
  // Windows names are case-insensitive ("Path"), so every spelling of the ones set here goes
  const kept = Object.entries(env).filter(([key]) => !/^(LLAMA|HF|GGML)_/i.test(key) && !(key.toUpperCase() in own));
  return { ...Object.fromEntries(kept), ...own };
};
