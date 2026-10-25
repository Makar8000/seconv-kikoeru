import path from "node:path";

// Imported first: every path in the app (profiles/, settings.json, lib/, queue/, .webview2/) is relative to the working
// directory, which must be the app's folder. A shortcut without "Start in", a terminal elsewhere or "Run as administrator"
// (System32) would otherwise put them there.
if (Bun.isStandaloneExecutable) {
  process.chdir(path.dirname(process.execPath));
}
