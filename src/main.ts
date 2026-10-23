import { config, LANGUAGES, TRANSLATE_ENGINES, updateConfig } from "./config/index.ts";
import { runTranslation } from "./translation/runner.ts";
import { getLogsSince, logger } from "./logger.ts";
import { findLlamaServer, findSeconv, SECONV_NOT_FOUND, unlinkLlamaCpp } from "./seconv/locate.ts";
import { localLlamaCppModel, usesLocalLlamaCpp } from "./seconv/convert.ts";
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

// A crash or forced close can leave a run's link to lib/llama.cpp/bin behind in lib/seconv
try {
  unlinkLlamaCpp();
} catch (e) {
  logger.warn(`Couldn't remove the llama.cpp link in lib/seconv. ${e}`);
}

type State = { running: boolean; installing: boolean; restoring: boolean; done: number; total: number };
const state: State = { running: false, installing: false, restoring: false, done: 0, total: 0 };

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
  localLlamaCppModel(); // throws when lib/llama.cpp isn't ready, before any queue folder is touched
  const controller = abort = new AbortController();
  Object.assign(state, { running: true, done: 0, total: 0 });
  logger.info("Starting translation...");
  runTranslation((p) => Object.assign(state, p), controller.signal)
    .then(() => logger.info(controller.signal.aborted ? "Translation stopped." : "Finished processing all files."))
    .catch((e) => logger.error(e))
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

const handlers: Record<string, (body: Record<string, unknown>, url: URL) => unknown> = {
  "GET /api/config": () => ({ config, engines: TRANSLATE_ENGINES, languages: LANGUAGES, seconvFound: findSeconv() !== null }),
  "POST /api/stop": () => (abort?.abort(), state),
  "POST /api/config": (body) => {
    const wasLocal = usesLocalLlamaCpp();
    updateConfig(body);
    // Choosing llama.cpp without a server URL downloads llama.cpp if it isn't there yet
    if (!wasLocal && usesLocalLlamaCpp() && !findLlamaServer()) {
      installLlama().catch(() => {}); // failures are logged by exclusive()
    }
    return { config };
  },
  "GET /api/state": (_body, url) => ({
    ...state,
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
  const item = (label: string, id: string) => ({ item: { label, id, enabled: true } });

  win.setApplicationMenu([
    {
      submenu: {
        label: "Tools",
        items: [item("Update seconv", "update-seconv"), item("Update llama.cpp", "update-llamacpp"), item("Restore backups", "restore-backups")],
      },
    },
  ]);

  // Failures are already logged (and shown in the console panel) by install()/installLlama()/restore()
  win.addEventListener("menuclick", (e: { detail: { id: string } }) => {
    if (e.detail.id === "update-seconv") install().catch(() => {});
    if (e.detail.id === "update-llamacpp") installLlama().catch(() => {});
    if (e.detail.id === "restore-backups") restore().catch(() => {});
  });
}
