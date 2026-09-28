import "@std/dotenv/load";
import { findBackupFilesByRjFolder, METADATA_FOLDER } from "./utils/fileDiscovery.ts";
import { logger } from "./utils/logger.ts";
import { restoreBackups } from "./utils/restorer.ts";

const main = async () => {
  // Find all backed-up files, grouped by the RJ folder that owns them
  const filesByRjFolder = findBackupFilesByRjFolder();

  // Keep track of any failed restorations across this run
  const allErrors: { rjFolder: string; error: { file: string; error: string } }[] = [];

  logger.info(`Found ${Object.keys(filesByRjFolder).length} folder entries.`);
  for (const [rjFolder, files] of Object.entries(filesByRjFolder)) {
    logger.info(`\nRestoring backups for ${rjFolder}...`);

    // Restore all backed-up files for this RJ folder
    const errors = restoreBackups(rjFolder, files);
    if (errors.length) {
      allErrors.push(...errors.map((error) => ({ rjFolder, error })));
      logger.error(`Completed ${rjFolder} with ${errors.length} error(s), keeping its ${METADATA_FOLDER} folder`);
      continue;
    }

    // No errors restoring this RJ folder, so its metadata folder can be removed entirely
    await Deno.remove(`${rjFolder}/${METADATA_FOLDER}`, { recursive: true });
    logger.info(`Completed ${rjFolder}`);
  }

  // If any restorations failed, log them
  if (allErrors.length) {
    const failedList = allErrors.map(({ rjFolder, error }) => `${rjFolder}/${error.file}: ${error.error}`).join("\n");
    logger.error(`\nSome restorations failed. List of failed files:\n${failedList}`);
  }

  alert("\nFinished restoring all backups. Press Enter to close...");
};

main().catch((error) => {
  logger.error(error);
  alert("\nPress Enter to close...");
});
