import { appendFileSync } from "node:fs";
import path from "node:path";

// Imported first, so this runs before any other module.

// Every path in the app (profiles/, settings.json, lib/, queue/, .webview2/) is relative to the working directory, which
// must be the app's folder. A shortcut without "Start in", a terminal elsewhere or "Run as administrator" (System32)
// would otherwise put them there.
if (Bun.isStandaloneExecutable) {
  process.chdir(path.dirname(process.execPath));
}

// The packaged app has no console, so a crash (while loading the settings, say) would leave no trace without this
const crash = (e: unknown) => {
  console.error(e);
  try {
    appendFileSync("crash.log", `${new Date().toISOString()} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  } catch {
    /* read-only folder: nothing more to be done */
  }
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
