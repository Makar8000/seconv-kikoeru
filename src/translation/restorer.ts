import { copyFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.ts";
import { BACKUPS_FOLDER, findBackupFilesByRjFolder, METADATA_FOLDER } from "./fileDiscovery.ts";

export type RestoreErrorEntry = { file: string; error: string };

/**
 * Restores the given backed-up `files` (paths relative to `rjFolder`) from
 * the backup folder back to their original location within `rjFolder`,
 * overwriting the (translated) file that's currently there.
 *
 * Returns the list of files that failed to restore, if any; a failure for one file does not
 * prevent the rest from being attempted.
 */
export const restoreBackups = (rjFolder: string, files: string[]): RestoreErrorEntry[] => {
  const errors: RestoreErrorEntry[] = [];

  for (const file of files) {
    const bakFilePath = path.join(rjFolder, METADATA_FOLDER, BACKUPS_FOLDER, file);
    const originalFilePath = path.join(rjFolder, file);

    try {
      logger.info(`Restoring ${file}`);
      mkdirSync(path.dirname(originalFilePath), { recursive: true });
      copyFileSync(bakFilePath, originalFilePath);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to restore ${file}. ${error}`);
      errors.push({ file, error });
    }
  }

  return errors;
};

/**
 * Restores every backed-up file found under the configured queue folder. An RJ folder whose files all
 * restored has its metadata folder removed; one with failures keeps it so the restore can be retried.
 */
export const restoreAllBackups = async () => {
  const filesByRjFolder = findBackupFilesByRjFolder();
  const allErrors: { rjFolder: string; error: RestoreErrorEntry }[] = [];

  logger.info(`Found ${Object.keys(filesByRjFolder).length} folder entries.`);
  for (const [rjFolder, files] of Object.entries(filesByRjFolder)) {
    logger.info(`\nRestoring backups for ${rjFolder}...`);
    const errors = restoreBackups(rjFolder, files);
    if (errors.length) {
      allErrors.push(...errors.map((error) => ({ rjFolder, error })));
      logger.error(`Completed ${rjFolder} with ${errors.length} error(s), keeping its ${METADATA_FOLDER} folder`);
      continue;
    }
    await rm(path.join(rjFolder, METADATA_FOLDER), { recursive: true });
    logger.info(`Completed ${rjFolder}`);
  }

  if (allErrors.length) {
    const failedList = allErrors.map(({ rjFolder, error }) => `${rjFolder}/${error.file}: ${error.error}`).join("\n");
    logger.error(`\nSome restorations failed. List of failed files:\n${failedList}`);
  }
};
