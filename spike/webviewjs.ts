// Phase 0 spike (throwaway): can @webviewjs/webview host the app's window under Bun?
// Run with `bun spike/webviewjs.ts`, drive it with the /ctl/* endpoints printed as URL=...
import path from "node:path";
import { existsSync } from "node:fs";

const logs: string[] = [];
const log = (m: string) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${m}`;
  logs.push(line);
  console.log(line);
};

const page = `<!doctype html><html><head><meta charset="utf-8"><title>webviewjs spike</title>
<style>body{font:14px system-ui;background:#0f1115;color:#e6e8ee;padding:16px}button{margin:4px;padding:6px 12px}pre{background:#171a21;padding:8px;min-height:140px;white-space:pre-wrap}</style></head>
<body><h2>webviewjs spike</h2>
<button onclick="spikeLog('prompt: ' + prompt('Name?', 'suggested'))">prompt()</button>
<button onclick="spikeLog('confirm: ' + confirm('Sure?'))">confirm()</button>
<button onclick="fetch('/api/ping').then(r => r.json()).then(j => spikeLog('ping: ' + JSON.stringify(j)))">fetch /api/ping</button>
<button onclick="document.title = 'spike ' + Date.now()">set document.title</button>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
function spikeLog(m) { out.textContent += m + String.fromCharCode(10); fetch("/log", { method: "POST", headers: { "content-type": "text/plain" }, body: String(m) }); }
spikeLog("page loaded at " + location.href + " | " + navigator.userAgent);
</script></body></html>`;

// deno-lint-ignore-file no-explicit-any
let app: any, win: any, view: any;
const menuFor = (current: string) => ({
  items: [
    {
      label: "&Profile",
      submenu: {
        items: [
          { id: "profile-new", label: "New" },
          { id: "profile-delete", label: "Delete", enabled: false },
          { role: "separator" },
          { id: "p1", label: `${current === "p1" ? "✓ " : ""}Local llama.cpp` },
          { id: "p2", label: `${current === "p2" ? "✓ " : ""}OpenRouter` },
        ],
      },
    },
    {
      label: "&Tools",
      submenu: {
        items: [
          { id: "update-seconv", label: "Update seconv" },
          { role: "separator" },
          { id: "restore-backups", label: "Restore backups" },
        ],
      },
    },
  ],
});
// runtime replacement test: does app.setMenu() update an existing window menu on Windows? (run 2: no)
const showMenu = (current: string) => {
  app.setMenu(menuFor(current));
  log(`app.setMenu(${current}) hasMenu=${win.hasMenu()}`);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/ping") return Response.json({ ok: true, t: Date.now() });
    if (url.pathname === "/log") {
      log(`page: ${await req.text()}`);
      return new Response("ok");
    }
    if (url.pathname === "/ctl/logs") return Response.json(logs);
    if (url.pathname === "/ctl/eval") {
      const js = await req.text();
      log(`ctl eval: ${js}`);
      view.evaluateScript(js);
      return new Response("ok");
    }
    if (url.pathname === "/ctl/title") {
      win.setTitle(await req.text());
      return new Response("ok");
    }
    if (url.pathname === "/ctl/menu") {
      showMenu(await req.text());
      return new Response("ok");
    }
    if (url.pathname === "/ctl/exit") {
      log("ctl exit");
      setTimeout(() => {
        app.exit();
        process.exit(0);
      }, 50);
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});
log(`URL=${server.url.href} PID=${process.pid} standalone=${Bun.isStandaloneExecutable} bun=${Bun.version} exe=${process.execPath}`);

if (Bun.isStandaloneExecutable) {
  // the addon embedded by the bundler can't be dlopen'ed; load the copy shipped next to the exe
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(path.dirname(process.execPath), "webview.win32-x64-msvc.node");
}
const { Application } = await import("@webviewjs/webview");
app = new Application();
const dataDir = path.resolve(".webview2-spike");
const ctx = app.createWebContext({ dataDirectory: dataDir });
log(`context dataDirectory=${ctx.dataDirectory}`);
win = app.createBrowserWindow({ title: "webviewjs spike", width: 860, height: 600, menu: menuFor("p1"), showMenu: true });
log(`window created hasMenu=${win.hasMenu()}`);
view = win.createWebview({ url: server.url.href, webContext: ctx });

app.on("custom-menu-click", (e: any) => {
  const id: string = e?.customMenuEvent?.id ?? JSON.stringify(e);
  log(`menu click: ${id} (${JSON.stringify(e)})`);
  if (id === "profile-new") view.evaluateScript(`spikeLog("menu->prompt: " + prompt("Profile name:", "New profile"))`);
  else if (id === "p1" || id === "p2") {
    showMenu(id);
    view.evaluateScript(`spikeLog("menu->switch: ${id}")`);
  } else view.evaluateScript(`spikeLog("menu: ${id}")`);
});
app.on("window-close-requested", (e: any) => {
  log(`window-close-requested ${JSON.stringify(e)}`);
  app.exit();
  setTimeout(() => process.exit(0), 50);
});
app.on("application-close-requested", () => log("application-close-requested"));
app.on("ready", () => log("app ready"));
view.on("title-changed", (e: any) => {
  log(`title-changed: ${JSON.stringify(e)}`);
  if (e?.title) win.setTitle(String(e.title));
});
view.on("page-load-finished", (e: any) => log(`page-load-finished ${JSON.stringify(e)}`));

app.run();
setInterval(() => log(`alive; dataDir=${existsSync(dataDir)} EBWebView=${existsSync(path.join(dataDir, "EBWebView"))}`), 5000);
