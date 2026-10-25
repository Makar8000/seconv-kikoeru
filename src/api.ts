import { statSync } from "node:fs";
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
  updateConfig,
} from "./config/index.ts";
import { getLogsSince, logger } from "./logger.ts";
import { installLlamaCpp, installSeconv } from "./seconv/installer.ts";
import { openLlamaCpp, stopLlamaServer, usesLlamaCpp } from "./seconv/llamacpp.ts";
import { findSeconv, SECONV_NOT_FOUND } from "./seconv/locate.ts";
import { restoreAllBackups } from "./translation/restorer.ts";
import { noProgress, type Progress, runTranslation } from "./translation/runner.ts";

/*
 * The app's local HTTP API for the page in src/ui: the page's files, the settings, start/stop, the installs, the restore
 * and the profile actions. It listens on 127.0.0.1 at a random port; the window loads `server.url`.
 */

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

/**
 * `phase`: what a run does before its files' progress says it (the llama.cpp set-up, the scan of the queue folder).
 * `scanOnly`: the last run was a scan (its counts are what a translation would do), from the Scan button.
 * `startedAt` / `finishedAt`: the last run's times (ms since the epoch; 0 when none), for the elapsed time in the page.
 */
export type State = {
  running: boolean;
  installing: boolean;
  restoring: boolean;
  phase: string;
  scanOnly: boolean;
  startedAt: number;
  finishedAt: number;
} & Progress;
export const state: State = {
  running: false,
  installing: false,
  restoring: false,
  phase: "",
  scanOnly: false,
  startedAt: 0,
  finishedAt: 0,
  ...noProgress(),
};

/** Why the app is busy, or "" when it's idle. */
export const busyReason = () =>
  state.running ? "a translation is running" : state.installing ? "a download is running" : state.restoring ? "backups are being restored" : "";
let abort: AbortController | undefined;

/** Whether the queue directory exists; the page says so under the field and keeps Start disabled until it does. */
const queueFound = () => {
  try {
    return statSync(path.resolve(config.rjPath)).isDirectory();
  } catch {
    return false;
  }
};

// no-store: the WebView would otherwise keep these (log lines, settings with API keys) in its disk cache
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Starts a translation run, or with `scanOnly` just the inspection of the queue (no llama-server for that). */
const start = (scanOnly = false) => {
  if (busyReason()) {
    return;
  }
  if (!findSeconv()) {
    throw new Error(SECONV_NOT_FOUND);
  }
  const controller = new AbortController();
  abort = controller;
  Object.assign(state, { running: true, phase: "Starting", scanOnly, startedAt: Date.now(), finishedAt: 0, ...noProgress() });
  hooks.stateChanged();
  const what = scanOnly ? "Scan" : "Translation";
  logger.info(scanOnly ? "Scanning the queue..." : "Starting translation...");
  const setPhase = (phase: string) => {
    state.phase = phase;
    hooks.stateChanged();
  };
  const translate = async () => {
    // llama.cpp: the server already running at its URL, or one started for this run (downloaded first if needed)
    if (usesLlamaCpp() && !scanOnly) {
      await openLlamaCpp(controller.signal, setPhase);
    }
    setPhase("Scanning");
    try {
      await runTranslation(
        (p) => {
          Object.assign(state, p);
          state.phase = ""; // from the first progress on, the counts say what's happening
          hooks.stateChanged();
        },
        controller.signal,
        scanOnly,
      );
    } finally {
      stopLlamaServer();
    }
  };
  translate()
    .then(() => {
      if (controller.signal.aborted) {
        logger.info(`${what} stopped.`);
      } else if (!scanOnly) {
        logger.info("Finished processing all files."); // a scan logs its own summary
      }
    })
    .catch((e) => (controller.signal.aborted ? logger.info(`${what} stopped.`) : logger.error(e)))
    .finally(() => {
      state.running = false;
      state.phase = "";
      state.finishedAt = Date.now();
      hooks.stateChanged();
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

export const install = () =>
  exclusive("installing", "update seconv", async () => ({ tag: await installSeconv(), seconvFound: findSeconv() !== null }));

export const installLlama = () => exclusive("installing", "update llama.cpp", () => installLlamaCpp());

const restore = () =>
  exclusive("restoring", "restore backups", async () => {
    await restoreAllBackups();
    logger.info("Finished restoring all backups.");
  });

/**
 * Set by the window: `stateChanged` shows the loaded profile and the run's progress (title, taskbar), `quit` closes the
 * window and exits, `focus` brings the window to the front.
 */
export const hooks: { stateChanged: () => void; quit: () => void; focus: () => void } = {
  stateChanged: () => {},
  quit: () => process.exit(0),
  focus: () => {},
};

/** Runs a Profile menu action or a switch in the page's profile dropdown; the page then reloads the settings. */
const changeProfile = (action: () => void) => {
  // A run reads the settings as it goes
  if (busyReason()) {
    throw new Error(`Can't change the profile while ${busyReason()}.`);
  }
  action();
  hooks.stateChanged();
};

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
    queueFound: queueFound(),
    logs: getLogsSince(Number(url.searchParams.get("since")) || 0),
  }),
  "POST /api/start": () => {
    start();
    return state;
  },
  "POST /api/scan": () => {
    start(true);
    return state;
  },
  // The page has confirmed that the running translation, download or restore may be killed
  "POST /api/quit": () => {
    hooks.quit();
    return state;
  },
  // A second launch of the app, which exits once this one's window is in front
  "POST /api/focus": () => {
    hooks.focus();
    return { app: APP };
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

/**
 * The API's port. Fixed, so that a second launch of the app finds the instance already running: it has that one bring its
 * window to the front and exits, as both would otherwise write the same profiles and start llama-server on the same port.
 */
const PORT = 51923;
/** What /api/focus answers, so that an unrelated program on the port isn't taken for a running instance. */
const APP = "seconv-kikoeru";

const serve = (port: number) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // an install or a restore holds its request for minutes
    async fetch(req) {
      const url = new URL(req.url);
      // Bun builds `req.url` from the Host header. A website whose DNS name is pointed at 127.0.0.1 would otherwise be
      // same-origin with this API in a browser (DNS rebinding) and could read the settings, API keys included.
      if (url.hostname !== "127.0.0.1") {
        return json({ error: "Forbidden" }, 403);
      }
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

/** Listens on PORT; when a running instance has it, exits after that one has shown its window. */
const listen = async () => {
  try {
    return serve(PORT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw e;
    }
  }
  const other = await fetch(`http://127.0.0.1:${PORT}/api/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(2000),
  })
    .then((res) => res.json())
    .then((body) => body?.app === APP)
    .catch(() => false);
  if (other) {
    process.exit(0);
  }
  // An unrelated program has the port; the window takes any
  return serve(0);
};

export const server = await listen();

// The llama-server, and the seconv, started for a run must not outlive the app
process.on("exit", () => {
  abort?.abort();
  stopLlamaServer();
});
