import "./appdir.ts";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  config,
  currentProfile,
  deleteProfile,
  duplicateProfile,
  LANGUAGES,
  listProfiles,
  newProfile,
  profileLoads,
  renameProfile,
  switchProfile,
  TRANSLATE_ENGINES,
  uniqueName,
  updateConfig,
} from "./config/index.ts";
import { getLogsSince, logger } from "./logger.ts";
import { installLlamaCpp, installSeconv } from "./seconv/installer.ts";
import { openLlamaCpp, stopLlamaServer, usesLlamaCpp } from "./seconv/llamacpp.ts";
import { findSeconv, SECONV_NOT_FOUND } from "./seconv/locate.ts";
import { restoreAllBackups } from "./translation/restorer.ts";
import { type Progress, runTranslation } from "./translation/runner.ts";

// The packaged app has no console, so a crash (before the window exists, say) would leave no trace without this
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

// The page's files, next to this one in src/ui; `bun run build` embeds them in the executable (--asset src/ui)
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};
const asset = (route: string) => {
  const { file, type } = ASSETS[route];
  return new Response(Bun.file(path.join(import.meta.dir, "ui", file)), { headers: { "content-type": type } });
};

type State = { running: boolean; installing: boolean; restoring: boolean } & Progress;
const state: State = { running: false, installing: false, restoring: false, done: 0, total: 0, filesDone: 0, filesTotal: 0 };

const busyReason = () =>
  state.running ? "a translation is running" : state.installing ? "a download is running" : state.restoring ? "backups are being restored" : "";
let abort: AbortController | undefined;

// no-store: the WebView would otherwise keep these (log lines, settings with API keys) in its disk cache
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const start = () => {
  if (busyReason()) {
    return;
  }
  if (!findSeconv()) {
    throw new Error(SECONV_NOT_FOUND);
  }
  const controller = new AbortController();
  abort = controller;
  Object.assign(state, { running: true, done: 0, total: 0, filesDone: 0, filesTotal: 0 });
  logger.info("Starting translation...");
  const translate = async () => {
    // llama.cpp: the server already running at its URL, or one started for this run (downloaded first if needed)
    if (usesLlamaCpp()) {
      await openLlamaCpp(controller.signal);
    }
    try {
      await runTranslation((p) => Object.assign(state, p), controller.signal);
    } finally {
      stopLlamaServer();
    }
  };
  translate()
    .then(() => logger.info(controller.signal.aborted ? "Translation stopped." : "Finished processing all files."))
    .catch((e) => (controller.signal.aborted ? logger.info("Translation stopped.") : logger.error(e)))
    .finally(() => {
      state.running = false;
    });
};

/**
 * Runs a background operation (install / restore) as the only active one. `flag` drives the header pill;
 * failures are logged here so they show up in the console panel, then re-thrown for the API response.
 */
const exclusive = async <T>(flag: "installing" | "restoring", what: string, task: () => Promise<T>) => {
  if (busyReason()) {
    throw new Error(`Can't ${what} while ${busyReason()}.`);
  }
  state[flag] = true;
  try {
    return await task();
  } catch (e) {
    logger.error(e);
    throw e;
  } finally {
    state[flag] = false;
  }
};

const install = () => exclusive("installing", "update seconv", async () => ({ tag: await installSeconv(), seconvFound: findSeconv() !== null }));

const installLlama = () => exclusive("installing", "update llama.cpp", () => installLlamaCpp());

const restore = () =>
  exclusive("restoring", "restore backups", async () => {
    await restoreAllBackups();
    logger.info("Finished restoring all backups.");
  });

/** Runs a Profile menu action or a switch in the page's profile dropdown; the page then reloads the settings. */
const changeProfile = (action: () => void) => {
  // A run reads the settings as it goes
  if (busyReason()) {
    throw new Error(`Can't change the profile while ${busyReason()}.`);
  }
  action();
  showTitle();
};

/** Shows the loaded profile's name in the window title; set once the window exists */
let showTitle = () => {};

const handlers: Record<string, (body: Record<string, unknown>, url: URL) => unknown> = {
  "GET /api/config": () => ({
    config,
    load: profileLoads(),
    engines: TRANSLATE_ENGINES,
    languages: LANGUAGES,
    profiles: listProfiles(),
    profile: currentProfile(),
    seconvFound: findSeconv() !== null,
  }),
  "POST /api/stop": () => {
    abort?.abort();
    return state;
  },
  "POST /api/config": (body) => {
    // An edit made in the page just before another profile was loaded belongs to the old one
    if (body.load !== profileLoads()) {
      throw new Error("The profile was changed, so the last edit wasn't saved.");
    }
    return { config: updateConfig(body) };
  },
  "GET /api/state": (_body, url) => ({
    ...state,
    load: profileLoads(),
    seconvFound: findSeconv() !== null,
    logs: getLogsSince(Number(url.searchParams.get("since")) || 0),
  }),
  "POST /api/start": () => {
    start();
    return state;
  },
  "POST /api/install-seconv": install,
  "POST /api/install-llamacpp": installLlama,
  "POST /api/restore-backups": async () => {
    await restore();
    return state;
  },
  // The page has already asked for the name or the confirmation
  "POST /api/profile": (body) => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const file = typeof body.file === "string" ? body.file : "";
    const actions: Record<string, (() => void) | undefined> = {
      new: name ? () => newProfile(name) : undefined,
      duplicate: name ? () => duplicateProfile(name) : undefined,
      rename: name ? () => renameProfile(name) : undefined,
      delete: deleteProfile,
      switch: file ? () => switchProfile(file) : undefined,
    };
    const action = Object.hasOwn(actions, String(body.action)) ? actions[String(body.action)] : undefined;
    if (!action) {
      throw new Error("Invalid profile action.");
    }
    changeProfile(action);
    return { load: profileLoads() };
  },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0, // an install or a restore holds its request for minutes
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname in ASSETS) {
      return asset(url.pathname);
    }

    const handler = handlers[`${req.method} ${url.pathname}`];
    if (!handler) {
      return json({ error: "Not found" }, 404);
    }

    // Requiring a JSON content type forces a CORS preflight for cross-origin pages, which we never grant,
    // so other websites can't drive this local API.
    if (req.method === "POST" && !req.headers.get("content-type")?.startsWith("application/json")) {
      return json({ error: "Expected application/json" }, 415);
    }

    try {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await handler(body, url));
    } catch (e) {
      logger.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
});

// ---- window ----
if (Bun.isStandaloneExecutable) {
  // The copy of the webview addon the bundler embeds can't be loaded; use the one shipped next to the executable
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(path.dirname(process.execPath), "webview.win32-x64-msvc.node");
}
// WebView2 reads this variable. No component downloads, no background traffic, and no GPU process.
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-component-update --disable-background-networking --disable-gpu";
const { Application } = await import("@webviewjs/webview");
const app = new Application();
// The embedded browser's data (cache, cookies) stays in the app folder
const context = app.createWebContext({ dataDirectory: path.resolve(".webview2") });
const item = (id: string, label: string) => ({ id, label });
// A window's menu can't change once the window exists, so the profiles themselves are listed in the page
const menu = {
  items: [
    {
      label: "&Profile",
      submenu: {
        items: [
          item("profile-new", "New"),
          item("profile-duplicate", "Duplicate"),
          item("profile-rename", "Rename"),
          item("profile-delete", "Delete"),
        ],
      },
    },
    {
      label: "&Tools",
      submenu: {
        items: [
          item("update-seconv", "Update seconv"),
          item("update-llamacpp", "Update llama.cpp"),
          { role: "separator" },
          item("restore-backups", "Restore backups"),
        ],
      },
    },
  ],
};
const win = app.createBrowserWindow({
  title: "seconv-kikoeru",
  // Sized so the whole form + console fit without scrolling
  width: 860,
  height: 900,
  showMenu: true,
  menu,
});
// The window shows its own copy of the menu; clicks only reach custom-menu-click for items the application menu knows
app.setMenu(menu);

/** Opens `url` in the system browser. */
const openInBrowser = (url: string) => {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" }).unref();
};

const view = win.createWebview({
  url: server.url.href,
  webContext: context,
  // The view shows the app's page only. A website link (target="_blank") goes to the system browser instead of the
  // popup window WebView2 would otherwise open on the app's browser profile.
  navigationHandler: (url) => url.startsWith(server.url.href) || url === "about:blank",
  newWindowHandler: ({ url }) => {
    if (url && /^https?:\/\//.test(url)) {
      openInBrowser(url);
    }
    return false;
  },
});

showTitle = () => win.setTitle(`seconv-kikoeru - Profile: ${config.name}`);
showTitle();

/** Runs `call` in the page: its prompt() and confirm() are the window's dialogs, and it posts the answer to the API. */
const inPage = (call: string) => view.evaluateScript(call);
// Failures are logged (and shown in the console panel) by install()/installLlama() and the API handlers
app.on("custom-menu-click", ({ customMenuEvent }) => {
  const id = customMenuEvent?.id;
  if (id === "update-seconv") {
    install().catch(() => {});
  }
  if (id === "update-llamacpp") {
    installLlama().catch(() => {});
  }
  if (id === "restore-backups") {
    inPage("confirmRestore()");
  }
  if (id === "profile-new") {
    inPage(`askProfile("new", ${JSON.stringify(uniqueName("New profile"))})`);
  }
  if (id === "profile-duplicate") {
    inPage(`askProfile("duplicate", ${JSON.stringify(uniqueName(`${config.name} (copy)`))})`);
  }
  if (id === "profile-rename") {
    inPage(`askProfile("rename", ${JSON.stringify(config.name)})`);
  }
  if (id === "profile-delete") {
    inPage(`askProfile("delete", ${JSON.stringify(config.name)})`);
  }
});
app.on("window-close-requested", () => {
  app.exit();
  setTimeout(() => process.exit(0), 50); // after the exit above, which the event pump defers
});
// The llama-server, and the seconv, started for a run must not outlive the app
process.on("exit", () => {
  abort?.abort();
  stopLlamaServer();
});
app.run();
