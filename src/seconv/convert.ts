import { execFile } from "node:child_process";
import * as path from "@std/path";
import { config, engineConfig } from "../config/index.ts";
import { logger } from "../logger.ts";
import { findSeconv, SECONV_NOT_FOUND } from "./locate.ts";

export type SeConvFileResult = { success: boolean; error?: string };

/** Per-file results of a `translateWithSeConv` call, keyed by the (absolute) input file path. */
export type SeConvResult = Map<string, SeConvFileResult>;

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
 * Runs `exe` and collects its output. Uses node:child_process because it can hide the console window Windows would
 * otherwise open for seconv (a console program) when started from this windowless desktop app; Deno.Command can't.
 * stdin is closed and stderr is captured, as the packaged app has no console to inherit.
 */
const run = (exe: string, args: string[], signal?: AbortSignal) =>
  new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(exe, args, { windowsHide: true, signal, maxBuffer: Infinity, encoding: "utf8" }, (error, stdout, stderr) => {
      // A non-zero exit still resolves: seconv reports per-file failures in its JSON output
      if (error && typeof error.code !== "number") {
        return reject(error);
      }
      resolve({ code: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    child.stdin?.end();
  });

/**
 * Invokes the `seconv` CLI to translate all `filePaths` (all sharing `format`) from/to the
 * configured languages. Returns a map keyed by each file's absolute path.
 */
export const translateWithSeConv = async (filePaths: string[], format: string, abortSignal?: AbortSignal): Promise<SeConvResult> => {
  const exe = findSeconv();
  if (!exe) {
    throw new Error(SECONV_NOT_FOUND);
  }

  const absoluteFilePaths = filePaths.map((filePath) => path.resolve(filePath));

  const engine = engineConfig();
  const args: string[] = [
    ...absoluteFilePaths,
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

  if (engine.url.length) {
    args.push("--translate-url", engine.url);
  }

  if (engine.model.length) {
    args.push("--translate-model", engine.model);
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

  logger.info(`Translating ${absoluteFilePaths.length} .${format} file(s), this may take a while...`);
  const startedAt = Date.now();

  // Emit a heartbeat while translation is in progress
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(`Still translating... (${elapsedSeconds}s elapsed)`);
  }, HEARTBEAT_INTERVAL);

  let code: number | null, signal: string | null, stdout: string, stderr: string;
  try {
    ({ code, signal, stdout, stderr } = await run(exe, args, abortSignal));
  } catch (error) {
    if (abortSignal?.aborted) {
      throw new Error("Translation stopped");
    }
    throw new Error(`Could not run seconv at "${exe}".\n${error}`);
  } finally {
    clearInterval(heartbeat);
  }

  const stderrText = stderr.trim();
  if (stderrText) {
    logger.warn(stderrText);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(`Finished translating after ${elapsedSeconds}s`);

  let parsed: SeConvJsonOutput;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // seconv crashed/errored before producing any JSON - treat every file as failed
    const signalSuffix = signal ? ` (signal ${signal})` : "";
    const error = `seconv produced no parseable JSON output (exit code ${code}${signalSuffix})`;
    logger.error(`Failed to translate files. ${error}`);
    return new Map(absoluteFilePaths.map((filePath) => [filePath, { success: false, error }]));
  }

  const resultsByPath = new Map<string, SeConvFileResult>();
  for (const fileEntry of parsed.files) {
    resultsByPath.set(fileEntry.input, {
      success: fileEntry.success,
      error: fileEntry.error ?? undefined,
    });
  }

  // seconv can silently omit a file from `files` (e.g. it doesn't exist, or the whole run failed
  // before any file was processed) - fall back to the run-level error, or a generic message
  const missingFileError = parsed.errors.length ? parsed.errors.join("; ") : "File was not found in seconv's output";

  for (const filePath of absoluteFilePaths) {
    if (!resultsByPath.has(filePath)) {
      resultsByPath.set(filePath, { success: false, error: missingFileError });
    }
  }

  return resultsByPath;
};
