import * as fs from "@std/fs";
import * as path from "@std/path";
import { config } from "../config/index.ts";

export const METADATA_FOLDER = ".trans-metadata";
export const BACKUPS_FOLDER = "backups";

/** A map of RJ code to the list of subtitle file paths (relative to `config.rjPath`) found for it. */
export type FilesByRjCode = { [rjcode: string]: string[] };

/** A map of RJ folder (absolute path) to the list of backed-up file paths (relative to that folder) found for it. */
export type BackupFilesByRjFolder = { [rjFolder: string]: string[] };

/**
 * Recursively finds all subtitle files (matching `config.subtitleExtensions`, case-insensitively)
 * under `config.rjPath`, excluding anything under the tool's own metadata folder, and groups
 * them by RJ code (or by parent folder, if no RJ code can be determined from the path).
 */
export const findSubtitleFilesByRjCode = (): FilesByRjCode => {
  const rjPathAbs = path.resolve(config.rjPath);

  return Array.from(fs.expandGlobSync(`**/*.{${config.subtitleExtensions.join(",")}}`, {
    root: config.rjPath,
    caseInsensitive: true,
  })).filter((walkEntry) => {
    // Exclude anything under the tool's own metadata folder
    return !walkEntry.path.split(path.SEPARATOR_PATTERN).includes(METADATA_FOLDER);
  }).map((walkEntry) => {
    // Determine the RJ code of a file
    const filePath = walkEntry.path.substring(rjPathAbs.length + 1);
    return {
      rjcode: filePath.match(/R.\d+/)?.[0] ?? path.dirname(filePath),
      filePath,
    };
  }).reduce((acc, cur) => {
    // Group files for the same RJ code together
    if (!acc[cur.rjcode]) {
      acc[cur.rjcode] = [];
    }
    acc[cur.rjcode].push(cur.filePath);
    return acc;
  }, {} as FilesByRjCode);
};

/**
 * Recursively finds all backup folders under `config.rjPath` and, for each,
 * lists the backed-up files within it (paths relative to the RJ folder).
 */
export const findBackupFilesByRjFolder = (): BackupFilesByRjFolder => {
  return Array.from(fs.expandGlobSync(`**/${METADATA_FOLDER}/${BACKUPS_FOLDER}/**/*`, {
    root: config.rjPath,
    includeDirs: false,
  })).reduce((acc, walkEntry) => {
    // Determine the RJ folder that owns this backup, and the file's path relative to it
    const segments = walkEntry.path.split(path.SEPARATOR_PATTERN);
    const metadataIndex = segments.lastIndexOf(METADATA_FOLDER);
    const rjFolder = segments.slice(0, metadataIndex).join(path.SEPARATOR);
    const relativeToRj = segments.slice(metadataIndex + 2).join(path.SEPARATOR);

    if (!acc[rjFolder]) {
      acc[rjFolder] = [];
    }
    acc[rjFolder].push(relativeToRj);
    return acc;
  }, {} as BackupFilesByRjFolder);
};
