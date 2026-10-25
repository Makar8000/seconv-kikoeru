import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.ts";

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

/** A file seconv found to be in `translateTo` already, so it isn't inspected again for that language. */
export type SkippedEntry = {
  file: string;
  timestamp: string;
  translateTo: string;
};

export type Manifest = {
  version: number;
  translated: TranslatedEntry[];
  errors: TranslationErrorEntry[];
  skipped: SkippedEntry[];
};

/** Type guard that checks whether a value parsed from JSON matches the shape of a `TranslatedEntry`. */
const isTranslatedEntry = (entry: unknown): entry is TranslatedEntry => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const e = entry as Record<string, unknown>;
  return (
    typeof e.file === "string" &&
    typeof e.timestamp === "string" &&
    typeof e.translateEngine === "string" &&
    typeof e.translateModel === "string" &&
    typeof e.translateFrom === "string" &&
    typeof e.translateTo === "string" &&
    Array.isArray(e.additionalArgs) &&
    e.additionalArgs.every((a) => typeof a === "string")
  );
};

/** Type guard that checks whether a value parsed from JSON matches the shape of a `TranslationErrorEntry`. */
const isTranslationErrorEntry = (entry: unknown): entry is TranslationErrorEntry => {
  return isTranslatedEntry(entry) && typeof (entry as Record<string, unknown>).error === "string";
};

const isSkippedEntry = (entry: unknown): entry is SkippedEntry => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return typeof e.file === "string" && typeof e.timestamp === "string" && typeof e.translateTo === "string";
};

/**
 * Reads and validates a `manifest.json` file at `manifestPath`.
 *
 * Returns an empty manifest (version `MANIFEST_VERSION`, no entries) if the file doesn't exist or fails to parse.
 * Any entries in the `translated`/`errors`/`skipped` arrays that don't match the expected shape are silently filtered out.
 */
export const loadManifest = (manifestPath: string): Manifest => {
  const empty: Manifest = { version: MANIFEST_VERSION, translated: [], errors: [], skipped: [] };

  if (!existsSync(manifestPath)) {
    return empty;
  }

  try {
    const json = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof json === "object" && json !== null) {
      const translated = Array.isArray(json.translated) ? json.translated.filter(isTranslatedEntry) : [];
      const errors = Array.isArray(json.errors) ? json.errors.filter(isTranslationErrorEntry) : [];
      const skipped = Array.isArray(json.skipped) ? json.skipped.filter(isSkippedEntry) : [];
      return { version: MANIFEST_VERSION, translated, errors, skipped };
    }
  } catch {
    logger.warn(`Failed to parse ${manifestPath}`);
  }

  return empty;
};

/** Writes a manifest to `manifestPath` as formatted JSON, creating the parent folder if it doesn't exist. */
export const saveManifest = (manifestPath: string, manifest: Manifest) => {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
