import path from "node:path";
import { config } from "../config/index.ts";
import { logger } from "../logger.ts";
import { inspect } from "../seconv/convert.ts";
import { findSubtitleFilesByRjCode } from "./fileDiscovery.ts";
import type { TranslationErrorEntry } from "./manifest.ts";
import { type PlannedFile, pendingFiles, translateFiles } from "./translator.ts";

/** Progress in lines (`done` / `total`, for the bar) and in files (for the status text). */
export type Progress = { done: number; total: number; filesDone: number; filesTotal: number };

/** Translates everything pending under the configured queue folder, reporting progress as it goes. */
export const runTranslation = async (onProgress: (progress: Progress) => void, signal?: AbortSignal) => {
  // Find and group all pending subtitle files by RJ code
  const filesByRjCode = findSubtitleFilesByRjCode();
  logger.info(`Found ${Object.keys(filesByRjCode).length} folder entries.`);

  // seconv inspects every pending file first: its format (there are several for .lrc), its line count for the progress
  // bar, and its language, as a file already in the target language needs no translation
  const plan: { rjcode: string; files: PlannedFile[] }[] = [];
  const progress: Progress = { done: 0, total: 0, filesDone: 0, filesTotal: 0 };
  for (const [rjcode, files] of Object.entries(filesByRjCode)) {
    const planned: PlannedFile[] = [];
    let lines = 0;
    for (const file of pendingFiles(rjcode, files)) {
      const info = await inspect(path.join(config.rjPath, file), signal);
      if ("error" in info) {
        planned.push({ file, format: "", lines: 0, error: info.error });
      } else if (info.language?.toLowerCase() === config.translateTo.toLowerCase()) {
        logger.info(`Skipping ${file}: already in ${config.translateTo}`);
      } else {
        planned.push({ file, format: info.format, lines: info.lines });
        lines += info.lines;
        progress.filesTotal++;
      }
    }
    if (planned.length) {
      plan.push({ rjcode, files: planned });
      progress.total += lines;
      logger.info(`${rjcode}: ${planned.filter((p) => !p.error).length} file(s), ${lines} line(s) to translate`);
    }
  }
  onProgress({ ...progress });

  // Keep track of any failed translations across this run
  const allErrors: { rjcode: string; error: TranslationErrorEntry }[] = [];

  for (const { rjcode, files } of plan) {
    if (signal?.aborted) {
      logger.warn("Stopped.");
      break;
    }
    logger.info(`\nParsing ${rjcode}...`);
    try {
      const errors = await translateFiles(
        rjcode,
        files,
        (lines) => {
          progress.done += lines;
          progress.filesDone++;
          onProgress({ ...progress });
        },
        signal,
      );
      allErrors.push(...errors.map((error) => ({ rjcode, error })));
      logger.info(`Completed ${rjcode}`);
    } catch (e) {
      if (!signal?.aborted) {
        logger.error(e);
      }
    }
  }

  // If any translations failed, log them
  if (allErrors.length) {
    const failedList = allErrors.map(({ rjcode, error }) => `${rjcode}/${error.file}\n  ${error.error}`).join("\n");
    logger.error(`\nSome translations failed. List of failed files:\n${failedList}`);
  }
};
