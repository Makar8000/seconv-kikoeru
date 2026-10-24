import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { BlobReader, ZipReader } from "@zip.js/zip.js";
import { reloadLanguages } from "../config/index.ts";
import { logger } from "../logger.ts";
import { LLAMACPP_BIN, LLAMACPP_MODELS, LLAMACPP_SERVER, SECONV_BINARY, SECONV_LANGUAGES, SECONV_LIB_DIR } from "./locate.ts";

const RELEASES_API = "https://api.github.com/repos/SubtitleEdit/subtitleedit/releases?per_page=30";
/** llama.cpp publishes its builds as b<number> pre-releases; the versioned releases in between carry no files. */
const LLAMACPP_RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10";
/** The Subtitle Edit source file that defines the LLM engines' language list, at release `tag`. */
const languagesSource = (tag: string) =>
  `https://raw.githubusercontent.com/SubtitleEdit/subtitleedit/${tag}/src/libuilogic/AutoTranslate/ChatGptTranslate.cs`;

type Release = { tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; size: number }[] };
type Asset = Release["assets"][number];

const WINDOWS = process.platform === "win32";

/** The `SeConv-<OS>-<Arch>` asset prefix for this machine, e.g. `SeConv-Windows-x64`. */
export const assetPrefix = (os: string = process.platform, arch: string = process.arch): string => {
  const osName = ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string | undefined>)[os];
  const archName = ({ x64: "x64", arm64: "ARM64" } as Record<string, string | undefined>)[arch];
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
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    throw new Error(`Refusing to extract "${name}" outside the target folder.`);
  }
  return target;
};

const extractZip = async (archive: string, dest: string) => {
  // Read lazily and streamed to disk: llama.cpp's CUDA runtime holds a ~470 MB file. zip.js closes the file when done.
  const reader = new ZipReader(new BlobReader(Bun.file(archive)));
  try {
    for (const entry of await reader.getEntries()) {
      const target = safeJoin(dest, entry.filename);
      if (entry.directory) {
        await mkdir(target, { recursive: true });
      } else if (entry.getData) {
        await mkdir(path.dirname(target), { recursive: true });
        await entry.getData(Writable.toWeb(createWriteStream(target)));
      }
    }
  } finally {
    await reader.close();
  }
};

/** Extracts a downloaded `.zip` / `.tar.gz` archive into `dest`. */
export const extractArchive = async (archive: string, dest: string) => {
  if (archive.endsWith(".zip")) {
    await extractZip(archive, dest);
  } else {
    // Bun.Archive refuses absolute entry paths, strips `..` and skips symlinks on Windows
    await new Bun.Archive(await Bun.file(archive).bytes()).extract(dest);
  }
};

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
    // One language per line, like the bundled languages.json
    await Bun.write(SECONV_LANGUAGES, `[\n${languages.map((l) => `  ${JSON.stringify(l)}`).join(",\n")}\n]\n`);
    logger.info(`Saved the language list of seconv ${tag} (${languages.length} languages).`);
  } catch (e) {
    logger.warn(`Couldn't get the language list of seconv ${tag}, using the built-in one. ${e}`);
  }
  reloadLanguages();
};

/** Lists a GitHub repository's releases, newest first. */
const fetchReleases = async (url: string, signal?: AbortSignal): Promise<Release[]> => {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "seconv-kikoeru" }, signal });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} ${res.statusText} while listing releases.`);
  }
  return res.json();
};

/**
 * Downloads `assets` (all from release `tag`) and extracts them together into `dir`, replacing any previous copy.
 * The new version is fully extracted and checked for `binary` before the old one is touched.
 */
const installAssets = async (dir: string, binary: string, tag: string, assets: Asset[], signal?: AbortSignal) => {
  const parent = path.dirname(dir);
  const staging = `${dir}.new`;
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    for (const asset of assets) {
      const archive = path.join(parent, asset.name);
      try {
        logger.info(`Downloading ${asset.name} (${tag}, ${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
        const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "seconv-kikoeru" }, signal });
        if (!download.ok || !download.body) {
          throw new Error(`Download failed: ${download.status} ${download.statusText}`);
        }
        await Bun.write(archive, download);

        logger.info("Extracting...");
        await extractArchive(archive, staging);
      } finally {
        await rm(archive, { force: true });
      }
    }

    const binaryPath = path.join(staging, binary);
    if (
      !(await stat(binaryPath).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new Error(`The downloaded archive does not contain ${binary}.`);
    }
    if (!WINDOWS) {
      await chmod(binaryPath, 0o755); // zips don't reliably carry the executable bit
    }

    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/**
 * Downloads the newest seconv pre-release for this OS/architecture and installs it into `lib/seconv/`,
 * replacing any previous copy, along with its language list.
 */
export const installSeconv = async (): Promise<string> => {
  const prefix = assetPrefix();
  logger.info("Looking up the latest seconv pre-release...");
  const { tag, asset } = pickAsset(await fetchReleases(RELEASES_API), prefix);
  await installAssets(SECONV_LIB_DIR, SECONV_BINARY, tag, [asset]);
  logger.info(`Installed seconv ${tag} to ${SECONV_LIB_DIR}`);
  await saveLanguages(tag);
  return tag;
};

/**
 * Downloads the newest llama.cpp build into lib/llama.cpp/bin/, replacing any previous one (models/ and config.ini
 * next to it are kept): the CUDA 13 build with its CUDA runtime when an NVIDIA driver is installed, else the CPU build.
 * Windows only: the builds for other systems rely on symlinks, which the extractor doesn't create.
 */
export const installLlamaCpp = async (signal?: AbortSignal): Promise<string> => {
  if (!WINDOWS) {
    throw new Error(`llama.cpp can only be downloaded on Windows. Put a llama.cpp release in ${LLAMACPP_BIN} yourself.`);
  }
  const arch = ({ x64: "x64", arm64: "arm64" } as Record<string, string | undefined>)[process.arch];
  // nvcuda.dll comes with the NVIDIA driver
  const nvcuda = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvcuda.dll");
  const cuda = await stat(nvcuda).then(
    (s) => s.isFile(),
    () => false,
  );
  const build = new RegExp(`^llama-b\\d+-bin-win-${cuda ? "cuda-(13\\.\\d+)" : "cpu"}-${arch}\\.zip$`);
  logger.info(`Looking up the latest llama.cpp ${cuda ? "CUDA" : "CPU"} build...`);

  for (const release of await fetchReleases(LLAMACPP_RELEASES_API, signal)) {
    const asset = release.assets.find((a) => build.test(a.name));
    // The CUDA build needs the CUDA runtime of the same version, which is published as a separate zip
    const runtime =
      asset && cuda ? release.assets.find((a) => a.name === `cudart-llama-bin-win-cuda-${build.exec(asset.name)?.[1]}-${arch}.zip`) : undefined;
    if (asset && (!cuda || runtime)) {
      await installAssets(LLAMACPP_BIN, LLAMACPP_SERVER, release.tag_name, runtime ? [asset, runtime] : [asset], signal);
      await mkdir(LLAMACPP_MODELS, { recursive: true });
      logger.info(`Installed llama.cpp ${release.tag_name} to ${LLAMACPP_BIN}. Models go in ${LLAMACPP_MODELS}.`);
      return release.tag_name;
    }
  }
  throw new Error(`No llama.cpp ${cuda ? "CUDA" : "CPU"} build for Windows ${arch} was found in the latest releases.`);
};
