import * as fs from "@std/fs";
import * as path from "@std/path";
import { config, engineConfig } from "../config/index.ts";
import { BACKUPS_FOLDER, METADATA_FOLDER } from "./fileDiscovery.ts";
import { logger } from "../logger.ts";
import { loadManifest, removeByFile, saveManifest, type TranslatedEntry, type TranslationErrorEntry, upsertByFile } from "./manifest.ts";
import { translateWithSeConv } from "../seconv/convert.ts";

const MANIFEST_FILENAME = "manifest.json";

/**
 * Backs up a single file into `<backup-folder>/<relative-path>`, mirroring the RJ
 * folder's structure. Skips the copy (and logs a notice) if a backup already exists for that file,
 * so the original pre-translation content is never overwritten by a later run.
 */
const backupFile = (rjFolder: string, relativeFile: string) => {
  const relativeToRj = path.relative(rjFolder, path.join(config.rjPath, relativeFile));
  const bakFilePath = path.join(rjFolder, METADATA_FOLDER, BACKUPS_FOLDER, relativeToRj);

  if (fs.existsSync(bakFilePath)) {
    logger.info(`Backup already exists for ${relativeFile}, skipping`);
    return;
  }

  logger.info(`Backing up ${relativeFile}`);
  const bakFolder = path.dirname(bakFilePath);
  if (!fs.existsSync(bakFolder)) {
    Deno.mkdirSync(bakFolder, { recursive: true });
  }
  Deno.copyFileSync(path.join(config.rjPath, relativeFile), bakFilePath);
};

/**
 * Translates the given `files` (paths relative to `config.rjPath`) belonging to a single RJ
 * folder, skipping any already recorded as translated in that folder's manifest.
 *
 * Pending files are backed up, then translated one `seconv` call at a time.
 * Each file's success/error result is recorded/updated in the manifest as soon as it's known.
 *
 * Returns the list of error entries produced during this call (for run-level reporting).
 */
export const translateFiles = async (
  rjcode: string,
  files: string[],
  /** Called with the number of files newly finished (skipped, translated or failed). */
  onProgress: (finished: number) => void = () => {},
  signal?: AbortSignal,
): Promise<TranslationErrorEntry[]> => {
  const rjFolder = path.join(config.rjPath, rjcode);
  const manifestPath = path.join(rjFolder, METADATA_FOLDER, MANIFEST_FILENAME);
  const manifest = loadManifest(manifestPath);
  const translatedFiles = new Set(manifest.translated.map((e) => e.file));

  // Converts a file path string to be relative to the rjfolder
  const toRjFolderRelative = (file: string) => path.relative(rjFolder, path.join(config.rjPath, file));

  // Skip any files that have already been successfully translated in a previous run
  const pendingFiles = files.filter((file) => !translatedFiles.has(toRjFolderRelative(file)));
  if (pendingFiles.length !== files.length) {
    logger.info(`Skipping ${files.length - pendingFiles.length} already-translated file(s)`);
  }

  onProgress(files.length - pendingFiles.length);

  if (!pendingFiles.length) {
    return [];
  }

  const runErrors: TranslationErrorEntry[] = [];

  // Create a backup of each file, mirroring the RJ folder structure
  for (const file of pendingFiles) {
    backupFile(rjFolder, file);
  }

  // One seconv call per file: progress moves file by file, and a stop or crash only loses the file in progress
  for (const file of pendingFiles) {
    const result = await translateWithSeConv(path.join(config.rjPath, file), signal);
    const timestamp = new Date().toISOString();
    // manifest entries are keyed by path relative to `rjFolder`, not `config.rjPath`
    const manifestFile = toRjFolderRelative(file);

    if (result.success) {
      upsertByFile<TranslatedEntry>(manifest.translated, {
        file: manifestFile,
        timestamp,
        translateEngine: config.translateEngine,
        translateModel: engineConfig().model,
        translateFrom: config.translateFrom,
        translateTo: config.translateTo,
        additionalArgs: engineConfig().additionalArgs,
      });
      removeByFile(manifest.errors, manifestFile);
    } else {
      const errorEntry: TranslationErrorEntry = {
        file: manifestFile,
        timestamp,
        translateEngine: config.translateEngine,
        translateModel: engineConfig().model,
        translateFrom: config.translateFrom,
        translateTo: config.translateTo,
        additionalArgs: engineConfig().additionalArgs,
        error: result.error ?? "Unknown error (seconv gave no reason)",
      };
      logger.error(`Failed: ${errorEntry.error}`);
      upsertByFile(manifest.errors, errorEntry);
      runErrors.push(errorEntry);
    }
    // Saved after every file, as seconv has already overwritten a translated one in place
    saveManifest(manifestPath, manifest);
    onProgress(1);
  }

  return runErrors;
};
