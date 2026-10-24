import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, engineConfig } from "../config/index.ts";
import { logger } from "../logger.ts";
import { translateWithSeConv } from "../seconv/convert.ts";
import { BACKUPS_FOLDER, METADATA_FOLDER } from "./fileDiscovery.ts";
import { loadManifest, removeByFile, saveManifest, type TranslatedEntry, type TranslationErrorEntry, upsertByFile } from "./manifest.ts";

const MANIFEST_FILENAME = "manifest.json";

/** A pending file (path relative to `config.rjPath`) as seconv inspected it, or the reason it can't be translated. */
export type PlannedFile = { file: string; format: string; lines: number; error?: string };

const manifestPathOf = (rjcode: string) => path.join(config.rjPath, rjcode, METADATA_FOLDER, MANIFEST_FILENAME);

// Manifest entries are keyed by path relative to the RJ folder, not `config.rjPath`
const toRjFolderRelative = (rjcode: string, file: string) => path.relative(path.join(config.rjPath, rjcode), path.join(config.rjPath, file));

/**
 * Backs up a single file into `<backup-folder>/<relative-path>`, mirroring the RJ
 * folder's structure. Skips the copy (and logs a notice) if a backup already exists for that file,
 * so the original pre-translation content is never overwritten by a later run.
 */
const backupFile = (rjFolder: string, relativeFile: string) => {
  const relativeToRj = path.relative(rjFolder, path.join(config.rjPath, relativeFile));
  const bakFilePath = path.join(rjFolder, METADATA_FOLDER, BACKUPS_FOLDER, relativeToRj);

  if (existsSync(bakFilePath)) {
    logger.info(`Backup already exists for ${relativeFile}, skipping`);
    return;
  }

  logger.info(`Backing up ${relativeFile}`);
  mkdirSync(path.dirname(bakFilePath), { recursive: true });
  copyFileSync(path.join(config.rjPath, relativeFile), bakFilePath);
};

/** The `files` (paths relative to `config.rjPath`) of RJ folder `rjcode` not yet recorded as translated in its manifest. */
export const pendingFiles = (rjcode: string, files: string[]): string[] => {
  const translated = new Set(loadManifest(manifestPathOf(rjcode)).translated.map((e) => e.file));
  const pending = files.filter((file) => !translated.has(toRjFolderRelative(rjcode, file)));
  if (pending.length !== files.length) {
    logger.info(`Skipping ${files.length - pending.length} already-translated file(s)`);
  }
  return pending;
};

/**
 * Translates the planned `files` of RJ folder `rjcode`, one `seconv` call at a time, backing each up first.
 * Each file's success/error result is recorded/updated in the manifest as soon as it's known.
 *
 * Returns the list of error entries produced during this call (for run-level reporting).
 */
export const translateFiles = async (
  rjcode: string,
  files: PlannedFile[],
  /** Called with the line count of each file finished (translated or failed). */
  onProgress: (lines: number) => void = () => {},
  signal?: AbortSignal,
): Promise<TranslationErrorEntry[]> => {
  const manifestPath = manifestPathOf(rjcode);
  const manifest = loadManifest(manifestPath);
  const runErrors: TranslationErrorEntry[] = [];

  for (const { file, format, lines, error } of files) {
    if (!error) {
      backupFile(path.join(config.rjPath, rjcode), file);
    }
    // A file seconv couldn't read is recorded as failed without a translation attempt
    const result = error ? { success: false, error } : await translateWithSeConv(path.join(config.rjPath, file), format, signal);
    const timestamp = new Date().toISOString();
    const manifestFile = toRjFolderRelative(rjcode, file);

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
      logger.error(`Failed ${file}: ${errorEntry.error}`);
      upsertByFile(manifest.errors, errorEntry);
      runErrors.push(errorEntry);
    }
    // Saved after every file, as seconv has already overwritten a translated one in place
    saveManifest(manifestPath, manifest);
    if (!error) {
      onProgress(lines);
    }
  }

  return runErrors;
};
