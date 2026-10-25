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
import { type Progress, runTranslation } from "./translation/runner.ts";

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

export const install = () =>
  exclusive("installing", "update seconv", async () => ({ tag: await installSeconv(), seconvFound: findSeconv() !== null }));

export const installLlama = () => exclusive("installing", "update llama.cpp", () => installLlamaCpp());

const restore = () =>
  exclusive("restoring", "restore backups", async () => {
    await restoreAllBackups();
    logger.info("Finished restoring all backups.");
  });

/** What the window does after a profile action: it shows the loaded profile's name in the title. */
export const hooks = { profileChanged: () => {} };

/** Runs a Profile menu action or a switch in the page's profile dropdown; the page then reloads the settings. */
const changeProfile = (action: () => void) => {
  // A run reads the settings as it goes
  if (busyReason()) {
    throw new Error(`Can't change the profile while ${busyReason()}.`);
  }
  action();
  hooks.profileChanged();
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

export const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
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

// The llama-server, and the seconv, started for a run must not outlive the app
process.on("exit", () => {
  abort?.abort();
  stopLlamaServer();
});
