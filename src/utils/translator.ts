import * as fs from "@std/fs";
import * as path from "@std/path";
import { config } from "../config/index.ts";
import { BACKUPS_FOLDER, METADATA_FOLDER } from "./fileDiscovery.ts";
import { logger } from "./logger.ts";
import { loadManifest, removeByFile, saveManifest, type TranslatedEntry, type TranslationErrorEntry, upsertByFile } from "./manifest.ts";
import { translateWithSeConv } from "./seconv.ts";

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
 * Pending files are backed up, then grouped by extension and translated.
 * Each file's success/error result from `seconv` is recorded/updated in the manifest.
 *
 * Returns the list of error entries produced during this call (for run-level reporting).
 */
export const translateFiles = async (rjcode: string, files: string[]): Promise<TranslationErrorEntry[]> => {
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

  if (!pendingFiles.length) {
    return [];
  }

  const runErrors: TranslationErrorEntry[] = [];

  try {
    // Create a backup of each file, mirroring the RJ folder structure
    for (const file of pendingFiles) {
      backupFile(rjFolder, file);
    }

    // Run the seconv batch process, grouped by file extension and parent folder
    for (const ext of config.subtitleExtensions) {
      const batchFiles = pendingFiles.filter((file) => path.extname(file).substring(1).toLowerCase() === ext.toLowerCase());
      if (!batchFiles.length) {
        continue;
      }

      const filePaths = batchFiles.map((file) => path.join(config.rjPath, file));
      const results = await translateWithSeConv(filePaths, ext);
      const timestamp = new Date().toISOString();

      for (let i = 0; i < batchFiles.length; i++) {
        const file = batchFiles[i];
        // results are keyed by absolute path, matching how seconv reports them back
        const result = results.get(path.resolve(filePaths[i]));
        // manifest entries are keyed by path relative to `rjFolder`, not `config.rjPath`
        const manifestFile = toRjFolderRelative(file);

        if (result?.success) {
          upsertByFile<TranslatedEntry>(manifest.translated, {
            file: manifestFile,
            timestamp,
            translateEngine: config.translateEngine,
            translateModel: config.translateModel,
            translateFrom: config.translateFrom,
            translateTo: config.translateTo,
            additionalArgs: config.seconvAdditionalArgs,
          });
          removeByFile(manifest.errors, manifestFile);
        } else {
          const errorEntry: TranslationErrorEntry = {
            file: manifestFile,
            timestamp,
            translateEngine: config.translateEngine,
            translateModel: config.translateModel,
            translateFrom: config.translateFrom,
            translateTo: config.translateTo,
            additionalArgs: config.seconvAdditionalArgs,
            error: result?.error ?? "Unknown error (seconv did not report a result for this file)",
          };
          upsertByFile(manifest.errors, errorEntry);
          runErrors.push(errorEntry);
        }
      }
    }
  } finally {
    // Persist progress even if a later file/extension group throws
    saveManifest(manifestPath, manifest);
  }

  return runErrors;
};
