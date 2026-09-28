import * as fs from "@std/fs";
import * as path from "@std/path";
import { BACKUPS_FOLDER, METADATA_FOLDER } from "./fileDiscovery.ts";
import { logger } from "./logger.ts";

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
      const originalFolder = path.dirname(originalFilePath);
      if (!fs.existsSync(originalFolder)) {
        Deno.mkdirSync(originalFolder, { recursive: true });
      }
      Deno.copyFileSync(bakFilePath, originalFilePath);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to restore ${file}. ${error}`);
      errors.push({ file, error });
    }
  }

  return errors;
};
