import path from "node:path";
import { config } from "../config/index.ts";
import { logger } from "../logger.ts";
import { inspect } from "../seconv/convert.ts";
import { findSubtitleFilesByRjCode } from "./fileDiscovery.ts";
import type { TranslationErrorEntry } from "./manifest.ts";
import { type PlannedFile, pendingFiles, recordSkipped, translateFiles } from "./translator.ts";

/**
 * Progress: files inspected while planning, then lines (`done` / `total`, for the bar) and files (for the status text).
 * `translatingAt` is when the first file's translation started (0 before): the page's ETA counts from there.
 */
export type Progress = {
  inspected: number;
  toInspect: number;
  done: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  translatingAt: number;
};
export const noProgress = (): Progress => ({ inspected: 0, toInspect: 0, done: 0, total: 0, filesDone: 0, filesTotal: 0, translatingAt: 0 });

/** Translates everything pending under the configured queue folder, reporting progress as it goes. */
export const runTranslation = async (onProgress: (progress: Progress) => void, signal?: AbortSignal) => {
  // Find and group all subtitle files by RJ folder, and keep what the manifests don't record as done
  const filesByRjCode = findSubtitleFilesByRjCode();
  logger.info(`Found ${Object.keys(filesByRjCode).length} folder entries.`);
  const pending = Object.entries(filesByRjCode).map(([rjcode, files]) => [rjcode, pendingFiles(rjcode, files)] as const);
  const progress = noProgress();
  progress.toInspect = pending.reduce((n, [, files]) => n + files.length, 0);
  onProgress({ ...progress });

  // seconv inspects every pending file first: its format (there are several for .lrc), its line count for the progress
  // bar, and its language, as a file already in the target language needs no translation
  const plan: { rjcode: string; files: PlannedFile[] }[] = [];
  for (const [rjcode, files] of pending) {
    const planned: PlannedFile[] = [];
    const skipped: string[] = [];
    let lines = 0;
    for (const file of files) {
      const info = await inspect(path.join(config.rjPath, file), signal);
      progress.inspected++;
      if ("error" in info) {
        planned.push({ file, format: "", lines: 0, error: info.error });
      } else if (info.language?.toLowerCase() === config.translateTo.toLowerCase()) {
        logger.info(`Skipping ${file}: already in ${config.translateTo}`);
        skipped.push(file);
      } else {
        planned.push({ file, format: info.format, lines: info.lines });
        lines += info.lines;
        progress.filesTotal++;
      }
      onProgress({ ...progress });
    }
    if (skipped.length) {
      recordSkipped(rjcode, skipped); // not inspected again next run
    }
    if (planned.length) {
      plan.push({ rjcode, files: planned });
      progress.total += lines;
      logger.info(`${rjcode}: ${planned.filter((p) => !p.error).length} file(s), ${lines} line(s) to translate`);
    }
  }
  progress.translatingAt = Date.now();
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
