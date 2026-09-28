import * as path from "@std/path";
import { config } from "../config/index.ts";
import { logger } from "./logger.ts";

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
 * Invokes the `seconv` CLI to translate all `filePaths` (all sharing `format`) from/to the
 * configured languages. Returns a map keyed by each file's absolute path.
 */
export const translateWithSeConv = async (filePaths: string[], format: string): Promise<SeConvResult> => {
  const absoluteFilePaths = filePaths.map((filePath) => path.resolve(filePath));

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

  if (!config.seconvAdditionalArgs.some((arg) => arg.startsWith("--format"))) {
    args.push(...["--format", format]);
  }

  if (config.translateUrl.length) {
    args.push(...["--translate-url", config.translateUrl]);
  }

  if (config.translateModel.length) {
    args.push(...["--translate-model", config.translateModel]);
  }

  if (config.translateFrom.length) {
    args.push(...["--translate-from", config.translateFrom]);
  }

  if (config.seconvAdditionalArgs.length) {
    args.push(...config.seconvAdditionalArgs);
  }

  const command = new Deno.Command(config.seconvPath, {
    args,
    stdout: "piped",
    stderr: "inherit",
  });

  logger.info(`Translating ${absoluteFilePaths.length} .${format} file(s), this may take a while...`);
  const startedAt = Date.now();

  // Emit a heartbeat while translation is in progress
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(`Still translating... (${elapsedSeconds}s elapsed)`);
  }, HEARTBEAT_INTERVAL);

  let code: number, signal: Deno.Signal | null, stdout: Uint8Array;
  try {
    ({ code, signal, stdout } = await command.output());
  } catch (error) {
    logger.error(`Could not run seconv at "${config.seconvPath}". Check that SECONV_PATH is correct.\n${error}`);
    Deno.exit(1);
  } finally {
    clearInterval(heartbeat);
  }

  const stdoutText = new TextDecoder().decode(stdout);
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(`Finished translating after ${elapsedSeconds}s`);

  let parsed: SeConvJsonOutput;
  try {
    parsed = JSON.parse(stdoutText);
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
