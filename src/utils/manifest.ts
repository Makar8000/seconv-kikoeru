import * as fs from "@std/fs";
import * as path from "@std/path";
import { logger } from "./logger.ts";

export const MANIFEST_VERSION = 1;

export type TranslationParams = {
  translateEngine: string;
  translateModel: string;
  translateFrom: string;
  translateTo: string;
  additionalArgs: string[];
};

export type TranslatedEntry = TranslationParams & {
  file: string;
  timestamp: string;
};

export type TranslationErrorEntry = TranslatedEntry & {
  error: string;
};

export type Manifest = {
  version: number;
  translated: TranslatedEntry[];
  errors: TranslationErrorEntry[];
};

/** Type guard that checks whether a value parsed from JSON matches the shape of a `TranslatedEntry`. */
const isTranslatedEntry = (entry: unknown): entry is TranslatedEntry => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const e = entry as Record<string, unknown>;
  return typeof e.file === "string" &&
    typeof e.timestamp === "string" &&
    typeof e.translateEngine === "string" &&
    typeof e.translateModel === "string" &&
    typeof e.translateFrom === "string" &&
    typeof e.translateTo === "string" &&
    Array.isArray(e.additionalArgs) && e.additionalArgs.every((a) => typeof a === "string");
};

/** Type guard that checks whether a value parsed from JSON matches the shape of a `TranslationErrorEntry`. */
const isTranslationErrorEntry = (entry: unknown): entry is TranslationErrorEntry => {
  return isTranslatedEntry(entry) && typeof (entry as Record<string, unknown>).error === "string";
};

/**
 * Reads and validates a `manifest.json` file at `manifestPath`.
 *
 * Returns an empty manifest (version `MANIFEST_VERSION`, no translated/error entries) if the file
 * doesn't exist or fails to parse. Any entries in the `translated`/`errors` arrays that don't match
 * the expected shape are silently filtered out.
 */
export const loadManifest = (manifestPath: string): Manifest => {
  const empty: Manifest = { version: MANIFEST_VERSION, translated: [], errors: [] };

  if (!fs.existsSync(manifestPath)) {
    return empty;
  }

  try {
    const data = Deno.readTextFileSync(manifestPath);
    const json = JSON.parse(data);
    if (typeof json === "object" && json !== null) {
      const translated = Array.isArray(json.translated) ? json.translated.filter(isTranslatedEntry) : [];
      const errors = Array.isArray(json.errors) ? json.errors.filter(isTranslationErrorEntry) : [];
      return { version: MANIFEST_VERSION, translated, errors };
    }
  } catch {
    logger.warn(`Failed to parse ${manifestPath}`);
  }

  return empty;
};

/** Writes a manifest to `manifestPath` as formatted JSON, creating the parent folder if it doesn't exist. */
export const saveManifest = (manifestPath: string, manifest: Manifest) => {
  const folder = path.dirname(manifestPath);
  if (!fs.existsSync(folder)) {
    Deno.mkdirSync(folder, { recursive: true });
  }

  Deno.writeTextFileSync(manifestPath, JSON.stringify(manifest, null, 2));
};

/** Upserts an entry into a manifest list, keyed by `file`, mutating the array in place. */
export const upsertByFile = <T extends { file: string }>(list: T[], entry: T): void => {
  const index = list.findIndex((e) => e.file === entry.file);
  if (index >= 0) {
    list[index] = entry;
  } else {
    list.push(entry);
  }
};

/** Removes an entry from a manifest list by `file`, mutating the array in place. */
export const removeByFile = <T extends { file: string }>(list: T[], file: string): void => {
  const index = list.findIndex((e) => e.file === file);
  if (index >= 0) {
    list.splice(index, 1);
  }
};
