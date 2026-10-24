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
import { runTranslation } from "./translation/runner.ts";
import { getLogsSince, logger } from "./logger.ts";
import { findSeconv, SECONV_NOT_FOUND } from "./seconv/locate.ts";
import { openLlamaCpp, stopLlamaServer, usesLlamaCpp } from "./seconv/llamacpp.ts";
import { installLlamaCpp, installSeconv } from "./seconv/installer.ts";
import { restoreAllBackups } from "./translation/restorer.ts";

// Static UI files, read once at startup (embedded in the binary via --include src/ui)
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};
const assets = Object.fromEntries(
  Object.entries(ASSETS).map(([route, a]) => [route, Deno.readTextFileSync(new URL(`./ui/${a.file}`, import.meta.url))]),
);

// The llama-server started for a run must not outlive the app
globalThis.addEventListener("unload", stopLlamaServer);

type State = { running: boolean; installing: boolean; restoring: boolean; done: number; total: number };
const state: State = { running: false, installing: false, restoring: false, done: 0, total: 0 };

const busyReason = () =>
  state.running ? "a translation is running" : state.installing ? "a download is running" : state.restoring ? "backups are being restored" : "";
let abort: AbortController | undefined;

// no-store: the WebView would otherwise keep these (log lines, settings with API keys) in its disk cache
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Shows the profiles in the window: the list in the menu, the loaded one's name in the title; set once the window exists
let showProfiles = () => {};

const start = () => {
  if (busyReason()) {
    return;
  }
  if (!findSeconv()) {
    throw new Error(SECONV_NOT_FOUND);
  }
  const controller = abort = new AbortController();
  Object.assign(state, { running: true, done: 0, total: 0 });
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
    .catch((e) => controller.signal.aborted ? logger.info("Translation stopped.") : logger.error(e))
    .finally(() => state.running = false);
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

const installLlama = () => exclusive("installing", "update llama.cpp", installLlamaCpp);

const restore = () =>
  exclusive("restoring", "restore backups", async () => {
    await restoreAllBackups();
    logger.info("Finished restoring all backups.");
  });

/** A Profile menu action. The page notices a switch on its next state poll and shows the profile's settings. */
const changeProfile = async (action: () => unknown) => {
  // A run reads the settings as it goes
  if (busyReason()) {
    logger.warn(`Can't change the profile while ${busyReason()}.`);
    return;
  }
  try {
    await action();
    showProfiles();
  } catch (e) {
    logger.error(e);
  }
};

const handlers: Record<string, (body: Record<string, unknown>, url: URL) => unknown> = {
  "GET /api/config": () => ({
    config,
    load: profileLoads(),
    engines: TRANSLATE_ENGINES,
    languages: LANGUAGES,
    seconvFound: findSeconv() !== null,
  }),
  "POST /api/stop": () => (abort?.abort(), state),
  "POST /api/config": (body) => {
    // An edit made in the page just before the menu loaded another profile belongs to the old one
    if (body.load !== profileLoads()) {
      throw new Error("The profile was changed in the menu, so the last edit wasn't saved.");
    }
    return { config: updateConfig(body) };
  },
  "GET /api/state": (_body, url) => ({
    ...state,
    load: profileLoads(),
    seconvFound: findSeconv() !== null,
    logs: getLogsSince(Number(url.searchParams.get("since")) || 0),
  }),
  "POST /api/start": () => (start(), state),
  "POST /api/install-seconv": install,
  "POST /api/restore-backups": async () => (await restore(), state),
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname in assets) {
    return new Response(assets[url.pathname], { headers: { "content-type": ASSETS[url.pathname].type } });
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
});

// deno-lint-ignore no-explicit-any
const BrowserWindow = (Deno as any).BrowserWindow;
if (BrowserWindow) {
  // Sized so the whole form + console fit without scrolling
  const win = new BrowserWindow({ title: "seconv-kikoeru", width: 860, height: 900 });
  const item = (label: string, id: string, checked = false, enabled = true) => ({ item: { label, id, enabled, checked } });

  /** Shows `dialog`, a prompt() or confirm() call, in the page and returns the answer. */
  const ask = async (dialog: string) => {
    const answer = await win.executeJs(dialog);
    // Deno 2.9.8 answers { ok, value }, although its types say the value itself
    return typeof answer === "object" && answer !== null ? answer.value : answer;
  };

  /** Asks for a profile name, then runs `action` with it; nothing when cancelled or left blank. */
  const withName = (suggested: string, action: (name: string) => void) => async () => {
    const name = await ask(`prompt("Profile name:", ${JSON.stringify(suggested)})`);
    if (typeof name === "string" && name.trim()) {
      action(name.trim());
    }
  };

  const confirmDelete = async () => {
    if (await ask(`confirm(${JSON.stringify(`Delete the profile "${config.name}"? This can't be undone.`)})`) === true) {
      deleteProfile();
    }
  };

  showProfiles = () => {
    const profiles = listProfiles();
    win.setTitle(`seconv-kikoeru - Profile: ${config.name}`);
    win.setApplicationMenu([
      {
        submenu: {
          label: "Profile",
          items: [
            item("New", "profile-new"),
            item("Duplicate", "profile-duplicate"),
            item("Rename", "profile-rename"),
            item("Delete", "profile-delete", false, profiles.length > 1),
            "separator",
            ...profiles.map((p) => item(p.name, `profile:${p.file}`, p.file === currentProfile())),
          ],
        },
      },
      {
        submenu: {
          label: "Tools",
          items: [
            item("Update seconv", "update-seconv"),
            item("Update llama.cpp", "update-llamacpp"),
            "separator",
            item("Restore backups", "restore-backups"),
          ],
        },
      },
    ]);
  };
  showProfiles();

  // Failures are already logged (and shown in the console panel) by install()/installLlama()/restore()/changeProfile()
  win.addEventListener("menuclick", (e: { detail: { id: string } }) => {
    const id = e.detail.id;
    if (id === "update-seconv") install().catch(() => {});
    if (id === "update-llamacpp") installLlama().catch(() => {});
    if (id === "restore-backups") restore().catch(() => {});
    if (id === "profile-new") changeProfile(withName(uniqueName("New profile"), newProfile));
    if (id === "profile-duplicate") changeProfile(withName(uniqueName(`${config.name} (copy)`), duplicateProfile));
    if (id === "profile-rename") changeProfile(withName(config.name, renameProfile));
    if (id === "profile-delete") changeProfile(confirmDelete);
    if (id.startsWith("profile:") && id !== `profile:${currentProfile()}`) {
      changeProfile(() => switchProfile(id.slice("profile:".length)));
    }
  });
}
