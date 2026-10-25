import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { BlobReader, ZipReader } from "@zip.js/zip.js";

/** Resolves `name` inside `dir` (absolute), refusing anything that would escape it (zip-slip). */
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
    await extractZip(archive, path.resolve(dest));
  } else {
    // Bun.Archive refuses absolute entry paths, strips `..` and skips symlinks on Windows
    await new Bun.Archive(await Bun.file(archive).bytes()).extract(dest);
  }
};
