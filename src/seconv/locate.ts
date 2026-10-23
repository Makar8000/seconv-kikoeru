import * as path from "@std/path";

export const SECONV_RELEASES_URL = "https://github.com/SubtitleEdit/subtitleedit/releases";
export const SECONV_NOT_FOUND =
  `seconv was not found. Use the download button, or get it from ${SECONV_RELEASES_URL} and put it in lib/seconv/ or in your PATH.`;

/** Where the app-managed copy of seconv lives (relative to the working directory, like config.json). */
export const SECONV_LIB_DIR = path.resolve("lib", "seconv");
export const SECONV_BINARY = Deno.build.os === "windows" ? "seconv.exe" : "seconv";
/** The app-managed seconv's translation languages, saved by the installer (seconv has no command to list them). */
export const SECONV_LANGUAGES = path.join(SECONV_LIB_DIR, "languages.json");

const isFile = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};

/**
 * Finds the `seconv` executable, or null if there isn't one. A binary in `lib/seconv/` wins over the PATH,
 * which is searched the way a shell would.
 */
export const findSeconv = (): string | null => {
  const local = path.join(SECONV_LIB_DIR, SECONV_BINARY);
  if (isFile(local)) return local;

  const extensions = Deno.build.os === "windows" ? (Deno.env.get("PATHEXT") ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (Deno.env.get("PATH") ?? "").split(path.DELIMITER).map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, "seconv" + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
};
