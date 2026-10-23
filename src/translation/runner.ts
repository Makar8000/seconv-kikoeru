import { findSubtitleFilesByRjCode } from "./fileDiscovery.ts";
import { logger } from "../logger.ts";
import type { TranslationErrorEntry } from "./manifest.ts";
import { translateFiles } from "./translator.ts";

/** Progress is counted in files for now (skipped files count as done). */
export type Progress = { done: number; total: number };

/** Translates everything pending under the configured queue folder, reporting progress as it goes. */
export const runTranslation = async (onProgress: (progress: Progress) => void, signal?: AbortSignal) => {
  // Find and group all pending subtitle files by RJ code
  const filesByRjCode = findSubtitleFilesByRjCode();
  const total = Object.values(filesByRjCode).reduce((sum, files) => sum + files.length, 0);
  let done = 0;
  onProgress({ done, total });

  // Keep track of any failed translations across this run
  const allErrors: { rjcode: string; error: TranslationErrorEntry }[] = [];

  logger.info(`Found ${Object.keys(filesByRjCode).length} folder entries.`);
  for (const [rjcode, files] of Object.entries(filesByRjCode)) {
    if (signal?.aborted) {
      logger.warn("Stopped.");
      break;
    }
    logger.info(`\nParsing ${rjcode}...`);
    const base = done;
    // Translate all pending files in the folder
    try {
      const errors = await translateFiles(rjcode, files, (n) => {
        done += n;
        onProgress({ done, total });
      }, signal);
      allErrors.push(...errors.map((error) => ({ rjcode, error })));
      logger.info(`Completed ${rjcode}`);
    } catch (e) {
      logger.error(e);
    } finally {
      // Whatever happened, this folder is finished
      done = base + files.length;
      onProgress({ done, total });
    }
  }

  // If any translations failed, log them
  if (allErrors.length) {
    const failedList = allErrors.map(({ rjcode, error }) => `${rjcode}/${error.file}\n  ${error.error}`).join("\n");
    logger.error(`\nSome translations failed. List of failed files:\n${failedList}`);
  }
};
