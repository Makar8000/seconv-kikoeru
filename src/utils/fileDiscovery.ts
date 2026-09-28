import * as fs from "@std/fs";
import * as path from "@std/path";
import { config } from "../config/index.ts";

export const TRANSLATED_FOLDER = ".translated";

/** A map of RJ code to the list of subtitle file paths (relative to `config.rjPath`) found for it. */
export type FilesByRjCode = { [rjcode: string]: string[] };

/**
 * Recursively finds all subtitle files (matching `config.subtitleExtensions`, case-insensitively)
 * under `config.rjPath`, excluding anything under the tool's own `.translated` folder, and groups
 * them by RJ code (or by parent folder, if no RJ code can be determined from the path).
 */
export const findSubtitleFilesByRjCode = (): FilesByRjCode => {
  const rjPathAbs = path.resolve(config.rjPath);

  return Array.from(fs.expandGlobSync(`**/*.{${config.subtitleExtensions.join(",")}}`, {
    root: config.rjPath,
    caseInsensitive: true,
  })).filter((walkEntry) => {
    // Exclude anything under the tool's own `.translated` folder
    return !walkEntry.path.split(path.SEPARATOR_PATTERN).includes(TRANSLATED_FOLDER);
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
