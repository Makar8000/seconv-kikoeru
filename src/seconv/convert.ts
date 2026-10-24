import { execFile } from "node:child_process";
import path from "node:path";
import { config, engineConfig } from "../config/index.ts";
import { logger } from "../logger.ts";
import { llamaCppUrl, usesLlamaCpp } from "./llamacpp.ts";
import { findSeconv, SECONV_NOT_FOUND } from "./locate.ts";

export type SeConvFileResult = { success: boolean; error?: string };

/** Shape of a single entry in the `files` array of `seconv --json` output. */
type SeConvJsonFileEntry = {
  input: string;
  output: string | null;
  success: boolean;
  error: string | null;
  warnings: string[] | null;
};

/** Shape of `seconv --json` output for a conversion run. */
type SeConvJsonOutput = {
  success: boolean;
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  files: SeConvJsonFileEntry[];
  errors: string[];
};

const HEARTBEAT_INTERVAL = 10_000;

/**
 * Runs `exe` and collects its output. `windowsHide` keeps Windows from opening a console window for seconv (a console
 * program) when it's started from this windowless desktop app. stdin is closed and stderr is captured, as the packaged
 * app has no console to inherit.
 */
const run = (exe: string, args: string[], signal?: AbortSignal) =>
  new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Translation stopped"));
    }
    const child = execFile(exe, args, { windowsHide: true, signal, maxBuffer: Infinity, encoding: "utf8" }, (error, stdout, stderr) => {
      // A non-zero exit still resolves: seconv reports per-file failures in its JSON output
      if (error && typeof error.code !== "number") {
        return reject(new Error(signal?.aborted ? "Translation stopped" : `Could not run seconv at "${exe}".\n${error}`));
      }
      resolve({ code: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    child.stdin?.end();
  });

const parseJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What seconv makes of a file: the format it reads it as, its language (null if undetected) and its line count. */
export type SeConvInfo = { format: string; language: string | null; lines: number };

/**
 * Asks seconv (`seconv info`) to inspect `filePath`. seconv has no "same format as the input" and no `lrc` shortcut
 * (unlike `srt` and `vtt`), so the detected format's name is what the translation passes as `--format`. It saves with
 * the format's extension, so a format with another extension is refused: it would mean a new file next to this one.
 */
export const inspect = async (filePath: string, signal?: AbortSignal): Promise<SeConvInfo | { error: string }> => {
  const exe = findSeconv();
  if (!exe) {
    throw new Error(SECONV_NOT_FOUND);
  }
  const { stdout, stderr } = await run(exe, ["info", path.resolve(filePath), "--json"], signal);
  const info = parseJson(stdout);
  if (!info?.format) {
    // On a failure seconv prints {"error": "..."} on stderr instead
    return { error: String(parseJson(stderr)?.error ?? (stderr.trim() || "seconv info gave no output")) };
  }
  if (String(info.extension).toLowerCase() !== path.extname(filePath).toLowerCase()) {
    return { error: `Detected as ${info.format} (${info.extension}), which seconv would write to a new file instead of this one.` };
  }
  return { format: String(info.format), language: info.language ? String(info.language) : null, lines: Number(info.paragraphCount) || 0 };
};

/** Invokes the `seconv` CLI to translate `filePath`, read as `format` (see `inspect`), in place from/to the configured languages. */
export const translateWithSeConv = async (filePath: string, format: string, abortSignal?: AbortSignal): Promise<SeConvFileResult> => {
  const exe = findSeconv();
  if (!exe) {
    throw new Error(SECONV_NOT_FOUND);
  }

  const absoluteFilePath = path.resolve(filePath);

  const engine = engineConfig();
  // llama.cpp always goes through a server at its URL (one we started for this run, or one that was already running);
  // its model setting is ours, not seconv's
  const llamaCpp = usesLlamaCpp();
  const url = llamaCpp ? llamaCppUrl() : engine.url;
  const model = llamaCpp ? "" : engine.model;
  const args: string[] = [
    absoluteFilePath,
    "--translate-engine",
    config.translateEngine,
    "--translate-to",
    config.translateTo,
    "--overwrite",
    "--no-language-suffix",
    "--json",
  ];

  if (!engine.additionalArgs.some((arg) => arg.startsWith("--format"))) {
    args.push("--format", format);
  }

  if (url.length) {
    args.push("--translate-url", url);
  }

  if (model.length) {
    args.push("--translate-model", model);
  }

  if (engine.apiKey.length) {
    args.push("--translate-api-key", engine.apiKey);
  }

  if (engine.useCustomPrompt && engine.prompt.length) {
    args.push("--translate-prompt", engine.prompt);
  }

  if (config.translateFrom.length) {
    args.push("--translate-from", config.translateFrom);
  }

  if (engine.additionalArgs.length) {
    args.push(...engine.additionalArgs);
  }

  logger.info(`Translating ${path.relative(config.rjPath, absoluteFilePath)} (${format})...`);
  const startedAt = Date.now();

  // Emit a heartbeat while translation is in progress
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(`Still translating... (${elapsedSeconds}s elapsed)`);
  }, HEARTBEAT_INTERVAL);

  let code: number | null, signal: string | null, stdout: string, stderr: string;
  try {
    ({ code, signal, stdout, stderr } = await run(exe, args, abortSignal));
  } finally {
    clearInterval(heartbeat);
  }

  const stderrText = stderr.trim();
  if (stderrText) {
    logger.warn(stderrText);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(`Finished translating after ${elapsedSeconds}s`);

  const parsed: SeConvJsonOutput | undefined = parseJson(stdout);
  if (!parsed) {
    // seconv crashed/errored before producing any JSON - treat the file as failed
    const signalSuffix = signal ? ` (signal ${signal})` : "";
    return { success: false, error: `seconv produced no parseable JSON output (exit code ${code}${signalSuffix})` };
  }

  // seconv can silently omit the file from `files` (e.g. it doesn't exist, or the run failed before it was processed) -
  // fall back to the run-level error, or a generic message
  const entry = parsed.files.find((f) => f.input === absoluteFilePath);
  if (!entry) {
    return { success: false, error: parsed.errors.length ? parsed.errors.join("; ") : "File was not found in seconv's output" };
  }
  return { success: entry.success, error: entry.error ?? undefined };
};
