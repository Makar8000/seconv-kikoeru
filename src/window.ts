import { spawn } from "node:child_process";
import path from "node:path";
import { busyReason, hooks, install, installLlama, state } from "./api.ts";
import { config, uniqueName } from "./config/index.ts";

/** Opens `url` in the system browser. */
const openInBrowser = (url: string) => {
  let cmd = "xdg-open";
  let args = [url];
  if (process.platform === "win32") {
    cmd = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    cmd = "open";
  }
  spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" }).unref();
};

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

/** Opens the app's window on `url`, the local API's page, and starts the desktop event loop. */
export const openWindow = async (url: string) => {
  if (Bun.isStandaloneExecutable) {
    // The copy of the webview addon the bundler embeds can't be loaded; use the one shipped next to the executable
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(path.dirname(process.execPath), "webview.win32-x64-msvc.node");
  }
  // WebView2 reads this variable. No component downloads, no background traffic, and no GPU process.
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-component-update --disable-background-networking --disable-gpu";
  const { Application, ProgressBarState } = await import("@webviewjs/webview");
  const app = new Application();
  // The embedded browser's data (cache, cookies) stays in the app folder
  const context = app.createWebContext({ dataDirectory: path.resolve(".webview2") });
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
  const view = win.createWebview({
    url,
    webContext: context,
    // The view shows the app's page only. A website link (target="_blank") goes to the system browser instead of the
    // popup window WebView2 would otherwise open on the app's browser profile.
    navigationHandler: (target) => target.startsWith(url) || target === "about:blank",
    newWindowHandler: ({ url: target }) => {
      if (target && /^https?:\/\//.test(target)) {
        openInBrowser(target);
      }
      return false;
    },
  });

  /** The title (the run's progress first, so the taskbar button shows it) and the taskbar progress bar follow the state */
  const showState = () => {
    const inspecting = state.running && state.inspected < state.toInspect;
    let percent = 0;
    if (state.total) {
      percent = Math.round((state.done / state.total) * 100);
    }
    let phase = "";
    let bar = ProgressBarState.None;
    if (state.phase) {
      phase = `${state.phase} - `;
      bar = ProgressBarState.Indeterminate;
    } else if (inspecting) {
      phase = `Inspecting ${state.inspected}/${state.toInspect} - `;
      bar = ProgressBarState.Indeterminate;
    } else if (state.running) {
      phase = `${percent}% - `;
      bar = ProgressBarState.Normal;
    } else if (state.total > 0 && state.done >= state.total) {
      phase = "Done - ";
    }
    win.setTitle(`${phase}seconv-kikoeru - Profile: ${config.name}`);
    win.setProgressBar({ state: bar, progress: percent });
  };
  showState();
  hooks.stateChanged = showState;
  // A second launch of the app asks for this instead of opening its own window
  hooks.focus = () => {
    win.setMinimized(false);
    win.show();
    win.focus();
  };

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
  // Closing while a run, a download or a restore is busy would kill it mid-file: the page asks first, and posts /api/quit
  // on a yes. window-close-requested only follows a close this event lets through.
  win.on("close", (e) => {
    if (busyReason()) {
      e.preventDefault();
      inPage(`confirmQuit(${JSON.stringify(busyReason())})`);
    }
  });
  const quit = () => {
    app.exit();
    setTimeout(() => process.exit(0), 50); // after the exit above, which the event pump defers
  };
  hooks.quit = quit;
  app.on("window-close-requested", quit);
  app.run();
};
