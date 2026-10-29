import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/* Directory listings for the page's path picker (ui/picker.js). Entries carry their absolute path, so the page needs no path logic. */

export type Entry = { name: string; path: string; kind: "file" | "folder" };
/** `parent` is "" at a drive root and null for the roots list; `error` is set when the folder can't be read. */
export type Listing = { path: string; parent: string | null; entries: Entry[]; error?: string };
export type ListOptions = { showHidden?: boolean; extensions?: string[] };

const compare = new Intl.Collator(undefined, { sensitivity: "base", numeric: true }).compare;
const REASONS: Record<string, string> = { EPERM: "Access denied", EACCES: "Access denied", ENOENT: "Folder not found", ENOTDIR: "Not a folder" };

/** The drive letters that exist on Windows; `/` and the home folder elsewhere. */
const roots = (): Entry[] => {
  if (process.platform !== "win32") {
    return [
      { name: "/", path: "/", kind: "folder" },
      { name: homedir(), path: homedir(), kind: "folder" },
    ];
  }
  const drives: Entry[] = [];
  for (let letter = 65; letter <= 90; letter++) {
    const drive = `${String.fromCharCode(letter)}:\\`;
    try {
      statSync(drive);
      drives.push({ name: drive, path: drive, kind: "folder" });
    } catch {
      /* no such drive */
    }
  }
  return drives;
};

/** The roots for "", else `dir`'s subfolders then its files, sorted case-insensitively; dot and `$` entries only with `showHidden`. */
export const listPath = (dir: string, { showHidden = false, extensions }: ListOptions = {}): Listing => {
  if (!dir.trim()) {
    return { path: "", parent: null, entries: roots() };
  }
  const resolved = path.resolve(dir);
  const above = path.dirname(resolved);
  const listing: Listing = { path: resolved, parent: above === resolved ? "" : above, entries: [] };
  let found: Dirent[];
  try {
    found = readdirSync(resolved, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    listing.error = REASONS[code] ?? (e instanceof Error ? e.message : String(e));
    return listing;
  }
  const wanted = extensions ? new Set(extensions.map((ext) => ext.toLowerCase())) : undefined;
  const folders: Entry[] = [];
  const files: Entry[] = [];
  for (const entry of found) {
    if (!showHidden && /^[.$]/.test(entry.name)) {
      continue;
    }
    const full = path.join(resolved, entry.name);
    let isFolder = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(full);
        isFolder = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue; // a broken link
      }
    }
    if (isFolder) {
      folders.push({ name: entry.name, path: full, kind: "folder" });
    } else if (isFile && (!wanted || wanted.has(path.extname(entry.name).slice(1).toLowerCase()))) {
      files.push({ name: entry.name, path: full, kind: "file" });
    }
  }
  folders.sort((a, b) => compare(a.name, b.name));
  files.sort((a, b) => compare(a.name, b.name));
  listing.entries = [...folders, ...files];
  return listing;
};
