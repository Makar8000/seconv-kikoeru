import "@std/dotenv/load";
import { findSubtitleFilesByRjCode } from "./utils/fileDiscovery.ts";
import { logger } from "./utils/logger.ts";
import type { TranslationErrorEntry } from "./utils/manifest.ts";
import { translateFiles } from "./utils/translator.ts";

const main = async () => {
  // Find and group all pending subtitle files by RJ code
  const filesByRjCode = findSubtitleFilesByRjCode();

  // Keep track of any failed translations across this run
  const allErrors: { rjcode: string; error: TranslationErrorEntry }[] = [];

  logger.info(`Found ${Object.keys(filesByRjCode).length} folder entries.`);
  for (const [rjcode, files] of Object.entries(filesByRjCode)) {
    logger.info(`\nParsing ${rjcode}...`);
    // Translate all pending files in the folder
    try {
      const errors = await translateFiles(rjcode, files);
      allErrors.push(...errors.map((error) => ({ rjcode, error })));
      logger.info(`Completed ${rjcode}`);
    } catch (e) {
      logger.error(e);
      continue;
    }
  }

  // If any translations failed, log them
  if (allErrors.length) {
    const failedList = allErrors.map(({ rjcode, error }) => `${rjcode}/${error.file}`).join("\n");
    logger.error(`\nSome translations failed. List of failed files:\n${failedList}`);
  }

  alert("\nFinished processing all files. Press Enter to close...");
};

main().catch((error) => {
  logger.error(error);
  alert("\nPress Enter to close...");
});
