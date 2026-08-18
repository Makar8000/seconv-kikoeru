import "@std/dotenv/load";
import * as fs from "@std/fs";
import * as path from "@std/path";
import { loadFailedTranslations, logger } from "./common.ts";

const RJ_PATH = Deno.env.get("RJ_PATH") ?? "./queue";
const SECONV_PATH = Deno.env.get("SECONV_PATH");
const TRANSLATE_ENGINE = Deno.env.get("TRANSLATE_ENGINE") ?? "llamacpp";
const TRANSLATE_MODEL = Deno.env.get("TRANSLATE_MODEL") ?? "";
const TRANSLATE_URL = Deno.env.get("TRANSLATE_URL") ?? "";
const TRANSLATE_FROM = Deno.env.get("TRANSLATE_FROM") ?? "";
const TRANSLATE_TO = Deno.env.get("TRANSLATE_TO") ?? "en";
const SECONV_ADDITIONAL_ARGS = Deno.env.get("SECONV_ADDITIONAL_ARGS")?.split(",") ?? [];
const SUBTITLE_EXTENSIONS = Deno.env.get("SUBTITLE_EXTENSIONS")?.split(",") ?? ["lrc", "srt", "vtt"];
const ERRORS_FILE = Deno.env.get("ERRORS_FILE") ?? "./data/tlerrors.json";

const failedTranslations = loadFailedTranslations(ERRORS_FILE);

const translateWithSeConv = async (filesGlob: string, format: string): Promise<boolean> => {
  const args: string[] = [
    filesGlob,
    "--translate-engine",
    TRANSLATE_ENGINE,
    "--translate-to",
    TRANSLATE_TO,
    "--overwrite",
  ];

  if (!SECONV_ADDITIONAL_ARGS.includes("--format")) {
    args.push(...["--format", format]);
  }

  if (TRANSLATE_URL.length) {
    args.push(...["--translate-url", TRANSLATE_URL]);
  }

  if (TRANSLATE_MODEL.length) {
    args.push(...["--translate-model", TRANSLATE_MODEL]);
  }

  if (TRANSLATE_FROM.length) {
    args.push(...["--translate-from", TRANSLATE_FROM]);
  }

  if (SECONV_ADDITIONAL_ARGS.length) {
    args.push(...SECONV_ADDITIONAL_ARGS);
  }

  const command = new Deno.Command(SECONV_PATH!, {
    args,
    stdout: "inherit",
  });
  const child = command.spawn();
  const status = await child.status;

  if (!status.success) {
    logger.error(`Failed to translate file. seconv process exited with code ${status.code}: ${status.signal}`);
    writeFailedTranslations(filesGlob, format);
  }

  return status.success;
};

const translateFiles = async (files: string[]): Promise<void> => {
  // Create a backup of each file in a `bak` subfolder
  for (const file of files) {
    backupFile(path.join(RJ_PATH, file));
  }

  // Run the seconv batch process, grouped by file extension and parent folder
  for (const ext of SUBTITLE_EXTENSIONS) {
    const filesWithExt = new Set<string>();
    files.filter((file) => path.extname(file).substring(1) === ext)
      .forEach((file) => filesWithExt.add(path.join(path.dirname(path.join(RJ_PATH, file)), `*.${ext}`)));
    for (const filesGlob of filesWithExt) {
      await translateWithSeConv(filesGlob, ext);
    }
  }
};

const backupFile = (file: string) => {
  logger.info(`Backing up ${file}`);
  const bakFolder = path.join(path.dirname(file), "bak");
  const bakFilePath = path.join(bakFolder, path.basename(file));
  if (!fs.existsSync(bakFolder)) {
    Deno.mkdirSync(bakFolder, { recursive: true });
  }
  Deno.copyFileSync(file, bakFilePath);
};

const writeFailedTranslations = (filesGlob: string, ext: string) => {
  failedTranslations.push({ filesGlob, ext });

  // Ensure the folder exists
  const tlErrorsFolder = path.dirname(ERRORS_FILE);
  if (!fs.existsSync(tlErrorsFolder)) {
    Deno.mkdirSync(tlErrorsFolder, { recursive: true });
  }

  // Write file
  Deno.writeTextFileSync(ERRORS_FILE, JSON.stringify(failedTranslations, null, 2));
};

const main = async () => {
  // Find list of subtitle files
  const data = Array.from(fs.expandGlobSync(`**/*.{${SUBTITLE_EXTENSIONS.join(",")}}`, {
    root: RJ_PATH,
  })).filter((walkEntry) => {
    // Exclude any existing backup files
    return path.basename(path.dirname(walkEntry.path)) !== "bak";
  }).map((walkEntry) => {
    // Determine the RJ code of a file
    const filePath = walkEntry.path.substring(path.resolve(RJ_PATH).length + 1);
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
  }, {} as { [key: string]: Array<string> });

  // Keep track of any new failed translations
  const oldFailedCount = failedTranslations.length;

  logger.info(`Found ${Object.keys(data).length} folder entries.`);
  for (const [rjcode, files] of Object.entries(data)) {
    logger.info(`\nParsing ${rjcode}...`);
    // Translate all files in folder
    try {
      await translateFiles(files);
      logger.info(`Completed ${rjcode}`);
    } catch (e) {
      logger.error(e);
      continue;
    }
  }

  // If any translations failed, log the new ones
  if (failedTranslations.length > oldFailedCount) {
    const failedList = failedTranslations.slice(oldFailedCount);
    logger.error(`\nSome translations failed. List of failed files:\n${failedList.map((file) => file.filesGlob).join("\n")}`);
  }

  alert("\nFinished processing all files. Press Enter to close...");
};

main().catch((error) => {
  logger.error(error);
  alert("\nPress Enter to close...");
});
