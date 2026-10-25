import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { config, type EngineConfig, engineConfig } from "../config/index.ts";
import { logger } from "../logger.ts";
import { heartbeat } from "../utils/heartbeat.ts";
import { run } from "../utils/process.ts";
import { installLlamaCpp } from "./installer.ts";
import {
  findLlamaServer,
  findModel,
  LLAMACPP_BIN,
  LLAMACPP_MODELS,
  LLAMACPP_SERVER,
  LLAMACPP_TOOL,
  llamaCppEnv,
  writeLlamaCppConfig,
} from "./locate.ts";

/** The llamacpp engine's server when its URL setting is empty. */
export const DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8080/";
const READY_TIMEOUT = 5 * 60_000;
/** A Hugging Face file page or download link: https://huggingface.co/<user>/<repo>/blob/main/<file>.gguf */
const HF_FILE_URL = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:blob|resolve)\/[^/]+\/([^?#]+)/;

/** True for the llamacpp engine (seconv also takes "llama.cpp" and "llama" for it). */
export const usesLlamaCpp = () => ["llamacpp", "llama.cpp", "llama"].includes(config.translateEngine.toLowerCase());

/**
 * The server URL the llamacpp engine uses. "localhost" becomes 127.0.0.1: that's where a server this app starts listens,
 * and seconv would try ::1 first for every request. Any other host is left alone, such as a server elsewhere on the LAN.
 */
export const llamaCppUrl = () => {
  const url = new URL(engineConfig().url || DEFAULT_LLAMACPP_URL);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.href;
};

/** The llama-server this app started for the current run. */
let server: ChildProcess | undefined;

/** Stops the llama-server this app started, if one is running. */
export const stopLlamaServer = () => {
  server?.kill();
  server = undefined;
};

/** What answers at `origin`: a llama.cpp server, something else, or nothing. */
const probe = async (origin: string): Promise<"llama.cpp" | "other" | "none"> => {
  try {
    const res = await fetch(`${origin}/props`, { signal: AbortSignal.timeout(5000) });
    const props = await res.json().catch(() => undefined);
    // llama-server names itself in every response, and /props reports its build ("b11840-36e36e63a"); while it's
    // loading a model, /props answers 503 instead. Other OpenAI-compatible servers have neither.
    const llamaCpp = res.headers.get("server") === "llama.cpp" && (res.status === 503 || typeof props?.build_info === "string");
    return llamaCpp ? "llama.cpp" : "other";
  } catch (e) {
    // Refused: nothing listens there. A timeout: something does, but it doesn't answer like a web server.
    return e instanceof DOMException && e.name === "TimeoutError" ? "other" : "none";
  }
};

/** The model file the llama.cpp server at `origin` serves, from /props. */
const servedModel = async (origin: string): Promise<string | undefined> => {
  const props = await fetch(`${origin}/props`, { signal: AbortSignal.timeout(5000) })
    .then((res) => res.json())
    .catch(() => undefined);
  return typeof props?.model_path === "string" ? props.model_path : undefined;
};

/**
 * Whether `served` (a server's model file) is the `model` setting: a Hugging Face file link, user/repo[:quant] (served
 * from the Hugging Face cache layout the downloader uses), or a file name.
 */
const isModel = (served: string, model: string) => {
  const file = path.basename(served).toLowerCase();
  const url = HF_FILE_URL.exec(model);
  if (url) {
    return file === path.basename(decodeURIComponent(url[2])).toLowerCase();
  }
  if (!model.includes("/")) {
    return file === (/\.gguf$/i.test(model) ? model : `${model}.gguf`).toLowerCase();
  }
  const [repo, quant] = model.split(":");
  return served.toLowerCase().includes(`models--${repo.replace("/", "--")}`.toLowerCase()) && (!quant || file.includes(quant.toLowerCase()));
};

/** Waits until the llama.cpp server at `origin` has loaded its model. */
const waitUntilReady = async (origin: string, signal: AbortSignal) => {
  for (const deadline = Date.now() + READY_TIMEOUT; Date.now() < deadline; ) {
    signal.throwIfAborted();
    const res = await fetch(`${origin}/health`, { signal }).catch(() => undefined);
    await res?.body?.cancel();
    if (res?.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The llama.cpp server at ${origin} wasn't ready after ${READY_TIMEOUT / 60_000} minutes.`);
};

/** Runs llama.cpp's own model downloader and resolves with the downloaded file (the last line it prints). */
const llamaDownload = async (args: string[], signal: AbortSignal) => {
  // Into lib/llama.cpp/models, in Hugging Face's cache layout. Its config home is bin/, which holds no config.ini:
  // ours turns on offline mode.
  const env = { ...llamaCppEnv(process.env, LLAMACPP_BIN), LLAMA_CACHE: LLAMACPP_MODELS };
  const { code, stdout, stderr } = await run(path.join(LLAMACPP_BIN, LLAMACPP_TOOL), ["download", ...args, "--no-mmproj"], {
    signal,
    cwd: LLAMACPP_BIN,
    env,
  });
  if (code !== 0) {
    throw new Error(`llama.cpp couldn't get the model. ${stderr.trim().slice(-2000)}`);
  }
  return stdout.trim().split(/\r?\n/).pop() ?? "";
};

/**
 * The .gguf to serve for the model setting: a Hugging Face file link or repository (user/repo or user/repo:quant),
 * downloaded into lib/llama.cpp/models by llama.cpp's own downloader the first time; or a file name in that folder.
 */
const resolveModel = async (model: string, signal: AbortSignal) => {
  const url = HF_FILE_URL.exec(model);
  if (!url && !model.includes("/")) {
    return findModel(model);
  }
  const args = url ? ["-hf", url[1], "-hff", decodeURIComponent(url[2])] : ["-hf", model];
  try {
    // A model that's already downloaded mustn't cost a request to Hugging Face
    return await llamaDownload([...args, "--offline"], signal);
  } catch (e) {
    if (signal.aborted) {
      throw e;
    }
  }

  // llama.cpp's downloader can't write past Windows' 260-character path limit, and its files sit over 100 characters
  // deep: models--<user>--<repo>\blobs\<64-character hash>.downloadInProgress
  const repo = url ? url[1] : model.split(":")[0];
  const deepest = path.join(LLAMACPP_MODELS, `models--${repo.replace("/", "--")}`, "blobs", `${"0".repeat(64)}.downloadInProgress`);
  if (process.platform === "win32" && deepest.length > 259) {
    throw new Error(`The app's folder path is too long for llama.cpp's downloader. Move the app to a shorter path, like C:\\seconv-kikoeru.`);
  }
  logger.info(`Downloading ${model} into ${LLAMACPP_MODELS}, this may take a while...`);
  const stopHeartbeat = heartbeat("Still downloading the model...");
  try {
    return await llamaDownload(args, signal);
  } finally {
    stopHeartbeat();
  }
};

/** llama-server flags for the model's family, as seconv picks them for its own server (InferChatTemplate). */
const familyFlags = (model: string) => {
  const name = path.basename(model).toLowerCase();
  const gemma4 = /gemma-?4(?![a-z])/.test(name); // "gemma-4-12b", "gemma-4-e4b", but not TranslateGemma's "gemma-4b"
  if (name.includes("gemma") && !gemma4) {
    return ["--chat-template", "gemma", "--no-jinja"];
  }
  // These think by default, which leaves the translation empty
  return gemma4 || /qwen|afrislm|index-translate/.test(name) ? ["--reasoning", "off"] : [];
};

/** llama-server's default sampling, from the llamacpp settings. seconv sends no sampling of its own when it's given a URL. */
const samplingFlags = ({ temperature, topP, topK, repeatPenalty }: EngineConfig) =>
  Object.entries({ "--temp": temperature, "--top-p": topP, "--top-k": topK, "--repeat-penalty": repeatPenalty }).flatMap(([flag, value]) =>
    value === undefined ? [] : [flag, String(value)],
  );

/** Starts lib/llama.cpp/bin/llama-server with `model` on 127.0.0.1:`port` and waits until it's ready. */
const startServer = async (model: string, port: number, signal: AbortSignal) => {
  writeLlamaCppConfig();
  // seconv's own launch flags: every layer on the GPU (when the build has one), one 8192-token slot, prompt cache reuse
  const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "-c", "8192", "-np", "1", "--swa-full"];
  // openLlamaCpp installed llama.cpp if it was missing
  const child = spawn(
    findLlamaServer() ?? LLAMACPP_SERVER,
    [...args, "--cache-reuse", "256", ...familyFlags(model), ...samplingFlags(engineConfig())],
    {
      windowsHide: true,
      cwd: LLAMACPP_BIN,
      env: llamaCppEnv(process.env),
    },
  );
  server = child;
  // Its output stays in memory, for the error message if it doesn't start
  let output = "";
  const keep = (data: unknown) => {
    output = (output + data).slice(-2000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`llama-server stopped (exit code ${code}). ${output.trim()}`)));
  });
  exited.catch(() => {}); // once it's ready, a stop only shows in seconv's requests
  try {
    await Promise.race([waitUntilReady(`http://127.0.0.1:${port}`, signal), exited]);
  } catch (e) {
    stopLlamaServer();
    throw e;
  }
};

/**
 * Makes sure a llama.cpp server answers at the llamacpp URL. One that's already running there is used as it is.
 * Otherwise llama.cpp (when missing) and the model are downloaded, and llama-server is started on the URL's port
 * until stopLlamaServer().
 */
export const openLlamaCpp = async (signal: AbortSignal) => {
  const url = new URL(llamaCppUrl());
  const found = await probe(url.origin);
  if (found === "llama.cpp") {
    await waitUntilReady(url.origin, signal);
    // A llama-server this app started lives on when the app is force-killed, maybe with another profile's model
    const served = await servedModel(url.origin);
    const model = engineConfig().model;
    const fits = !served || !model || isModel(served, model);
    const note = fits ? "" : ` That isn't the profile's model (${model}); stop that server to have one started with it.`;
    logger[fits ? "info" : "warn"](
      `Using the llama.cpp server running at ${url.origin} as it is, with ${served ? path.basename(served) : "its model"} and its own sampling settings.${note}`,
    );
    return;
  }
  if (found === "other") {
    throw new Error(`Something other than llama.cpp answers at ${url.origin}. Stop it, or use another port in the server URL.`);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`No llama.cpp server answers at ${url.origin}, and one can only be started at http://127.0.0.1:<port>.`);
  }

  if (!findLlamaServer()) {
    await installLlamaCpp(signal);
  }
  const model = await resolveModel(engineConfig().model, signal);
  const port = Number(url.port) || 80;
  logger.info(`Starting llama-server on port ${port} with ${path.basename(model)}...`);
  await startServer(model, port, signal);
  logger.info("llama-server is ready.");
};
