import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip-js/zip-js";
import { UntarStream } from "@std/tar/untar-stream";
import * as path from "@std/path";
import { logger } from "../logger.ts";
import { reloadLanguages } from "../config/index.ts";
import { SECONV_BINARY, SECONV_LANGUAGES, SECONV_LIB_DIR } from "./locate.ts";

const RELEASES_API = "https://api.github.com/repos/SubtitleEdit/subtitleedit/releases?per_page=30";
/** The Subtitle Edit source file that defines the LLM engines' language list, at release `tag`. */
const languagesSource = (tag: string) =>
  `https://raw.githubusercontent.com/SubtitleEdit/subtitleedit/${tag}/src/libuilogic/AutoTranslate/ChatGptTranslate.cs`;

type Release = { tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; size: number }[] };

/** The `SeConv-<OS>-<Arch>` asset prefix for this machine, e.g. `SeConv-Windows-x64`. */
export const assetPrefix = (os = Deno.build.os, arch = Deno.build.arch): string => {
  const osName = { windows: "Windows", darwin: "macOS", linux: "Linux" }[os as string];
  const archName = { x86_64: "x64", aarch64: "ARM64" }[arch as string];
  if (!osName || !archName) {
    throw new Error(`No seconv build is published for ${os}/${arch}.`);
  }
  return `SeConv-${osName}-${archName}`;
};

/** Picks this platform's asset (`SeConv-<OS>-<Arch>.zip` or `.tar.gz`) from the newest published pre-release. */
export const pickAsset = (releases: Release[], prefix: string) => {
  const release = releases.find((r) => r.prerelease && !r.draft);
  if (!release) {
    throw new Error("No pre-release of Subtitle Edit was found.");
  }
  const asset = release.assets.find((a) => a.name === `${prefix}.zip` || a.name === `${prefix}.tar.gz`);
  if (!asset) {
    throw new Error(`Release ${release.tag_name} has no ${prefix}.zip / ${prefix}.tar.gz asset.`);
  }
  return { tag: release.tag_name, asset };
};

/** Resolves `name` inside `dir`, refusing anything that would escape it (zip-slip). */
const safeJoin = (dir: string, name: string): string => {
  const target = path.resolve(dir, name);
  if (target !== dir && !target.startsWith(dir + path.SEPARATOR)) {
    throw new Error(`Refusing to extract "${name}" outside the target folder.`);
  }
  return target;
};

const extractZip = async (archive: string, dest: string) => {
  const reader = new ZipReader(new BlobReader(new Blob([await Deno.readFile(archive)])));
  try {
    for (const entry of await reader.getEntries()) {
      const target = safeJoin(dest, entry.filename);
      if (entry.directory) {
        await Deno.mkdir(target, { recursive: true });
      } else {
        await Deno.mkdir(path.dirname(target), { recursive: true });
        await Deno.writeFile(target, await entry.getData!(new Uint8ArrayWriter()));
      }
    }
  } finally {
    await reader.close();
  }
};

const extractTarGz = async (archive: string, dest: string) => {
  const file = await Deno.open(archive);
  for await (const entry of file.readable.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new UntarStream())) {
    const target = safeJoin(dest, entry.path);
    if (!entry.readable) {
      // Directory entry
      await Deno.mkdir(target, { recursive: true });
      continue;
    }
    await Deno.mkdir(path.dirname(target), { recursive: true });
    await entry.readable.pipeTo((await Deno.create(target)).writable);
    if (Deno.build.os !== "windows") {
      await Deno.chmod(target, entry.header.mode & 0o777 || 0o644);
    }
  }
};

/** Extracts a downloaded `.zip` / `.tar.gz` seconv archive into `dest`. */
export const extractArchive = (archive: string, dest: string) => archive.endsWith(".zip") ? extractZip(archive, dest) : extractTarGz(archive, dest);

/** Pulls the `MakePair("English", "en")` entries out of Subtitle Edit's `ChatGptTranslate.cs`. */
export const parseLanguages = (source: string) =>
  [...source.matchAll(/MakePair\("([^"]+)",\s*"([^"]+)"\)/g)].map(([, name, code]) => ({ name, code }));

/**
 * Saves the language list of seconv `tag`, read from the Subtitle Edit source at that tag, and loads it.
 * Not fatal: if it fails, the bundled list is used instead.
 */
const saveLanguages = async (tag: string) => {
  try {
    const res = await fetch(languagesSource(tag), { headers: { "user-agent": "seconv-kikoeru" } });
    if (!res.ok) {
      throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
    }
    const languages = parseLanguages(await res.text());
    if (!languages.length) {
      throw new Error("No languages found in the source.");
    }
    await Deno.writeTextFile(SECONV_LANGUAGES, JSON.stringify(languages, null, 2));
    logger.info(`Saved the language list of seconv ${tag} (${languages.length} languages).`);
  } catch (e) {
    logger.warn(`Couldn't get the language list of seconv ${tag}, using the built-in one. ${e}`);
  }
  reloadLanguages();
};

/**
 * Downloads the newest seconv pre-release for this OS/architecture and installs it into `lib/seconv/`,
 * replacing any previous copy, along with its language list. The new version is fully extracted and checked
 * before the old one is touched.
 */
export const installSeconv = async (): Promise<string> => {
  const prefix = assetPrefix();
  logger.info("Looking up the latest seconv pre-release...");
  const res = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json", "user-agent": "seconv-kikoeru" } });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} ${res.statusText} while listing releases.`);
  }
  const { tag, asset } = pickAsset(await res.json(), prefix);

  const libDir = path.dirname(SECONV_LIB_DIR);
  const archive = path.join(libDir, asset.name);
  const staging = `${SECONV_LIB_DIR}.new`;
  await Deno.mkdir(libDir, { recursive: true });

  try {
    logger.info(`Downloading ${asset.name} (${tag}, ${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
    const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "seconv-kikoeru" } });
    if (!download.ok || !download.body) {
      throw new Error(`Download failed: ${download.status} ${download.statusText}`);
    }
    await download.body.pipeTo((await Deno.create(archive)).writable);

    logger.info("Extracting...");
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await Deno.mkdir(staging, { recursive: true });
    await extractArchive(archive, staging);

    const binary = path.join(staging, SECONV_BINARY);
    if (!(await Deno.stat(binary).then((s) => s.isFile, () => false))) {
      throw new Error(`The downloaded archive does not contain ${SECONV_BINARY}.`);
    }
    if (Deno.build.os !== "windows") {
      await Deno.chmod(binary, 0o755); // zips don't reliably carry the executable bit
    }

    await Deno.remove(SECONV_LIB_DIR, { recursive: true }).catch(() => {});
    await Deno.rename(staging, SECONV_LIB_DIR);
    logger.info(`Installed seconv ${tag} to ${SECONV_LIB_DIR}`);
    await saveLanguages(tag);
    return tag;
  } finally {
    await Deno.remove(archive).catch(() => {});
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
};
