import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config/index.ts";

export const METADATA_FOLDER = ".trans-metadata";
export const BACKUPS_FOLDER = "backups";

/** A map of RJ code to the list of subtitle file paths (relative to `config.rjPath`) found for it. */
export type FilesByRjCode = { [rjcode: string]: string[] };

/** A map of RJ folder (absolute path) to the list of backed-up file paths (relative to that folder) found for it. */
export type BackupFilesByRjFolder = { [rjFolder: string]: string[] };

/** Every file under `config.rjPath`, as path segments relative to it. Dot folders are included: the metadata folder is one. */
const walk = (): string[][] => {
  const root = path.resolve(config.rjPath);
  // Bun.Glob throws on a missing folder
  if (!existsSync(root)) {
    return [];
  }
  return [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true })].map((file) => file.split(/[\\/]/));
};

/**
 * Recursively finds all subtitle files (matching `config.subtitleExtensions`, case-insensitively)
 * under `config.rjPath`, excluding anything under the tool's own metadata folder, and groups
 * them by RJ code (or by parent folder, if no RJ code can be determined from the path).
 */
export const findSubtitleFilesByRjCode = (): FilesByRjCode => {
  const extensions = new Set(config.subtitleExtensions.map((e) => e.toLowerCase()));
  const files: FilesByRjCode = {};
  for (const segments of walk()) {
    if (
      segments.includes(METADATA_FOLDER) ||
      !extensions.has(
        path
          .extname(segments.at(-1) ?? "")
          .slice(1)
          .toLowerCase(),
      )
    ) {
      continue;
    }
    const filePath = segments.join(path.sep);
    const rjcode = filePath.match(/R.\d+/)?.[0] ?? path.dirname(filePath);
    files[rjcode] ??= [];
    files[rjcode].push(filePath);
  }
  return files;
};

/**
 * Recursively finds all backup folders under `config.rjPath` and, for each,
 * lists the backed-up files within it (paths relative to the RJ folder).
 */
export const findBackupFilesByRjFolder = (): BackupFilesByRjFolder => {
  const root = path.resolve(config.rjPath);
  const files: BackupFilesByRjFolder = {};
  for (const segments of walk()) {
    // The RJ folder owns the metadata folder; the backup's path relative to it follows `backups/`
    const metadataIndex = segments.lastIndexOf(METADATA_FOLDER);
    if (metadataIndex < 0 || segments[metadataIndex + 1] !== BACKUPS_FOLDER || segments.length < metadataIndex + 3) {
      continue;
    }
    const rjFolder = path.join(root, ...segments.slice(0, metadataIndex));
    files[rjFolder] ??= [];
    files[rjFolder].push(segments.slice(metadataIndex + 2).join(path.sep));
  }
  return files;
};
