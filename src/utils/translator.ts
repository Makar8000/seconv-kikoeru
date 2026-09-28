import * as fs from "@std/fs";
import * as path from "@std/path";
import { config } from "../config/index.ts";
import { TRANSLATED_FOLDER } from "./fileDiscovery.ts";
import { logger } from "./logger.ts";
import { loadManifest, removeByFile, saveManifest, type TranslatedEntry, type TranslationErrorEntry, upsertByFile } from "./manifest.ts";
import { translateWithSeConv } from "./seconv.ts";

const BACKUPS_FOLDER = "backups";
const MANIFEST_FILENAME = "manifest.json";

/**
 * Backs up a single file into `<rjFolder>/.translated/backups/<relative-path>`, mirroring the RJ
 * folder's structure. Skips the copy (and logs a notice) if a backup already exists for that file,
 * so the original pre-translation content is never overwritten by a later run.
 */
const backupFile = (rjFolder: string, relativeFile: string) => {
  const relativeToRj = path.relative(rjFolder, path.join(config.rjPath, relativeFile));
  const bakFilePath = path.join(rjFolder, TRANSLATED_FOLDER, BACKUPS_FOLDER, relativeToRj);

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
 * Pending files are backed up, then batched by extension and parent folder into `seconv` calls.
 * On success, each file in a batch is recorded/updated in the manifest's `translated` list (and
 * removed from `errors` if present); on failure, each file in the batch is recorded/updated in
 * `errors` instead. The manifest is persisted even if an error is thrown partway through.
 *
 * Returns the list of error entries produced during this call (for run-level reporting).
 */
export const translateFiles = async (rjcode: string, files: string[]): Promise<TranslationErrorEntry[]> => {
  const rjFolder = path.join(config.rjPath, rjcode);
  const manifestPath = path.join(rjFolder, TRANSLATED_FOLDER, MANIFEST_FILENAME);
  const manifest = loadManifest(manifestPath);
  const translatedFiles = new Set(manifest.translated.map((e) => e.file));

  // Skip any files that have already been successfully translated in a previous run
  const pendingFiles = files.filter((file) => !translatedFiles.has(file));
  if (pendingFiles.length !== files.length) {
    logger.info(`Skipping ${files.length - pendingFiles.length} already-translated file(s)`);
  }

  if (!pendingFiles.length) {
    return [];
  }

  const runErrors: TranslationErrorEntry[] = [];

  try {
    // Create a backup of each file, mirroring the RJ folder structure under `.translated/backups`
    for (const file of pendingFiles) {
      backupFile(rjFolder, file);
    }

    // Run the seconv batch process, grouped by file extension and parent folder
    for (const ext of config.subtitleExtensions) {
      const filesWithExt = pendingFiles.filter((file) => path.extname(file).substring(1).toLowerCase() === ext.toLowerCase());
      if (!filesWithExt.length) {
        continue;
      }

      const globsByFolder = new Map<string, string[]>();
      filesWithExt.forEach((file) => {
        const glob = path.join(path.dirname(path.join(config.rjPath, file)), `*.${ext}`);
        globsByFolder.set(glob, [...(globsByFolder.get(glob) ?? []), file]);
      });

      for (const [filesGlob, batchFiles] of globsByFolder) {
        const result = await translateWithSeConv(filesGlob, ext);
        const timestamp = new Date().toISOString();

        for (const file of batchFiles) {
          if (result.success) {
            upsertByFile<TranslatedEntry>(manifest.translated, {
              file,
              timestamp,
              translateEngine: config.translateEngine,
              translateModel: config.translateModel,
              translateFrom: config.translateFrom,
              translateTo: config.translateTo,
              additionalArgs: config.seconvAdditionalArgs,
            });
            removeByFile(manifest.errors, file);
          } else {
            const errorEntry: TranslationErrorEntry = {
              file,
              timestamp,
              translateEngine: config.translateEngine,
              translateModel: config.translateModel,
              translateFrom: config.translateFrom,
              translateTo: config.translateTo,
              additionalArgs: config.seconvAdditionalArgs,
              error: result.error ?? "Unknown error",
            };
            upsertByFile(manifest.errors, errorEntry);
            runErrors.push(errorEntry);
          }
        }
      }
    }
  } finally {
    // Persist progress even if a later file/extension group throws
    saveManifest(manifestPath, manifest);
  }

  return runErrors;
};
