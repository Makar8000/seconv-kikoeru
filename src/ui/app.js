const $ = (id) => document.getElementById(id);
const inputs = [...document.querySelectorAll("[data-key]")];
const lists = [...document.querySelectorAll("[data-list]")];
const extensionsList = document.querySelector('[data-list="subtitleExtensions"]');

const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error);
  }
  return data;
};

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
/** Appends a console line, stamped with the time it was logged (server lines bring theirs) */
const log = (level, text, time = Date.now()) => {
  const c = $("console");
  const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 5;
  const line = document.createElement("div");
  line.className = level;
  const stamp = document.createElement("span");
  stamp.className = "time";
  stamp.textContent = clock(time);
  const lead = text.match(/^\n*/)[0]; // a line that starts with blank lines keeps them above its stamp
  line.append(lead, stamp, text.slice(lead.length));
  c.append(line);
  if (stick) {
    c.scrollTop = c.scrollHeight;
  }
};
$("clear").addEventListener("click", () => $("console").replaceChildren());

// ---- config: every edit is saved automatically ----
// Fields marked data-engine (model, URL, prompt, ...) belong to the selected engine: they show that engine's settings,
// and the other engines' settings are held in `engines` untouched until the engine is switched.
const isEngine = (el) => "engine" in el.dataset;
const chips = (l) => [...l.querySelectorAll(".chip")].map((c) => c.dataset.value);
// Checkboxes hold a boolean in `checked`, every other field a string in `value`
const getValue = (f) => (f.type === "checkbox" ? f.checked : f.value);
const setValue = (f, v) => {
  if (f.type === "checkbox") {
    f.checked = Boolean(v);
  } else {
    f.value = v ?? "";
  }
};
let engines = {};
let shownEngine = "";
// Which profile load the form shows (it counts loads, not renames). Saves name it, so an edit made just before
// another profile was loaded isn't saved into that one
let shownLoad = -1;

const readEngine = () => ({
  ...Object.fromEntries(inputs.filter(isEngine).map((f) => [f.dataset.key, getValue(f)])),
  ...Object.fromEntries(lists.filter(isEngine).map((l) => [l.dataset.list, chips(l)])),
});

const read = () => ({
  ...Object.fromEntries(inputs.filter((f) => !isEngine(f)).map((f) => [f.dataset.key, getValue(f)])),
  ...Object.fromEntries(lists.filter((l) => !isEngine(l)).map((l) => [l.dataset.list, chips(l)])),
  engines: { ...engines, [shownEngine]: readEngine() },
  load: shownLoad,
});

// The Advanced section is closed by default, so its summary says when there are arguments inside
const showAdvancedSummary = () => {
  const n = chips(document.querySelector('[data-list="additionalArgs"]')).length;
  let text = "Advanced";
  if (n) {
    text = `Advanced · ${n} argument${n === 1 ? "" : "s"}`;
  }
  $("advancedSummary").textContent = text;
};

let saveTimer;
const save = () => {
  showAdvancedSummary();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { config } = await api("POST", "/api/config", read());
      // Show anything the server corrected (e.g. a blank required field), without touching the field being edited
      inputs.forEach((f) => {
        if (f !== document.activeElement) {
          setValue(f, (isEngine(f) ? config.engines[shownEngine] : config)?.[f.dataset.key]);
        }
      });
    } catch (e) {
      log("error", e.message);
    }
  }, 300);
};

// ---- chip lists (additional args, file extensions) ----
const addChip = (l, value) => {
  value = value.trim();
  if (!value || [...l.querySelectorAll(".chip")].some((c) => c.dataset.value === value)) {
    return false;
  }
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.dataset.value = value;
  chip.append(value);
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "×";
  del.title = "Remove";
  del.setAttribute("aria-label", `Remove ${value}`);
  del.addEventListener("click", () => {
    chip.remove();
    save();
  });
  chip.append(del);
  l.querySelector("input").before(chip);
  return true;
};

const renderList = (l, values) => {
  l.replaceChildren();
  const input = document.createElement("input");
  input.id = `${l.dataset.list}-input`;
  input.spellcheck = false;
  input.autocomplete = "off";
  const commit = () => {
    if (addChip(l, input.value)) {
      save();
    }
    input.value = "";
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !input.value) {
      l.querySelector(".chip:last-of-type")?.remove();
      save();
    }
  });
  input.addEventListener("blur", commit);
  l.append(input);
  l.addEventListener("click", (e) => e.target === l && input.focus());
  for (const v of values) {
    addChip(l, v);
  }
};

// seconv must be in lib/seconv/; the server tells us whether it is
let seconvMissing = false;

const setSeconvFound = (found) => {
  seconvMissing = !found;
  $("seconvNotice").hidden = found;
};

// The prompt is kept while it's switched off, but greyed out to show seconv's default is used instead
const syncPromptToggle = () => {
  $("translatePrompt").disabled = !$("useCustomPrompt").checked;
};

/**
 * The server each engine uses when its URL field is empty. llamacpp: the app's own default (src/seconv/llamacpp.ts),
 * where it starts llama-server if none runs. The others: seconv's built-in defaults.
 */
const EMPTY_URL = {
  llamacpp: "http://127.0.0.1:8080/",
  "openai-compatible": "http://localhost:8000/v1/chat/completions",
  libretranslate: "http://localhost:5000/",
  deepl: "https://api-free.deepl.com/",
};

const showEngine = () => {
  const e = engines[shownEngine] ?? { model: "", url: "", apiKey: "", prompt: "", additionalArgs: [] };
  for (const f of inputs.filter(isEngine)) {
    setValue(f, e[f.dataset.key]);
  }
  for (const l of lists.filter(isEngine)) {
    renderList(l, e[l.dataset.list]);
  }
  syncPromptToggle();
  showAdvancedSummary();
  // Another engine (or profile) may have another key: never show one the user didn't ask to see
  $("translateApiKey").type = "password";
  $("showApiKey").textContent = "Show";
  // The URL an empty field means: the app's own for llama.cpp, seconv's for the rest
  $("translateUrl").placeholder = EMPTY_URL[shownEngine] ?? "";
  const llamaCpp = shownEngine === "llamacpp";
  // Without a model, seconv sends none and the server uses its own default
  $("translateModel").placeholder = llamaCpp ? "Format: Hugging Face user/repo:quant or .gguf link" : "Server's default";
  $("translateModel").title = llamaCpp ? "user/repo:quant, a Hugging Face link, or a .gguf in lib/llama.cpp/models" : "";
  // Only show the fields that apply to the engine (seconv rejects an API key or prompt for engines that don't take one)
  for (const el of document.querySelectorAll("[data-engines]")) {
    el.hidden = !el.dataset.engines.split(" ").includes(shownEngine);
  }
};

// ---- dropdowns ----
const fillSelect = (select, options, current) => {
  // Keep a hand-edited value that isn't in the known list selectable
  const known = options.some((o) => o.value === current);
  const all = known || !current ? options : [...options, { value: current, label: current }];
  select.replaceChildren(...all.map((o) => new Option(o.label, o.value)));
  select.value = current;
};

const fillLanguages = (languages, current) => {
  const langs = languages.map((l) => ({ value: l.code, label: `${l.name} (${l.code})` }));
  fillSelect($("translateFrom"), [{ value: "", label: "Auto-detect" }, ...langs], current.translateFrom);
  fillSelect($("translateTo"), langs, current.translateTo);
};

const fill = ({ config, load, engines: engineNames, languages, seconvFound, profiles, profile }) => {
  shownLoad = load;
  setSeconvFound(seconvFound);
  fillSelect(
    $("profile"),
    profiles.map((p) => ({ value: p.file, label: p.name })),
    profile,
  );
  fillSelect(
    $("translateEngine"),
    engineNames.map((e) => ({ value: e, label: e })),
    config.translateEngine,
  );
  fillLanguages(languages, config);
  for (const f of inputs.filter((f) => f.tagName !== "SELECT" && !isEngine(f))) {
    f.value = config[f.dataset.key];
  }
  for (const l of lists.filter((l) => !isEngine(l))) {
    renderList(l, config[l.dataset.list]);
  }
  engines = structuredClone(config.engines);
  shownEngine = config.translateEngine;
  showEngine();
};

for (const f of inputs) {
  f.addEventListener(f.tagName === "SELECT" || f.type === "checkbox" ? "change" : "input", save);
}
$("useCustomPrompt").addEventListener("change", syncPromptToggle);
$("showApiKey").addEventListener("click", () => {
  const field = $("translateApiKey");
  const shown = field.type === "text";
  field.type = shown ? "password" : "text";
  $("showApiKey").textContent = shown ? "Show" : "Hide";
});
$("translateEngine").addEventListener("change", () => {
  engines[shownEngine] = readEngine(); // keep what was typed for the engine we're leaving
  shownEngine = $("translateEngine").value;
  showEngine();
});

// ---- profiles ----
// The window's Profile menu can't change once the window exists, so the list is the select in the header, and the
// menu's actions ask for their name here, where prompt()/confirm() are
const profileAction = async (body) => {
  try {
    await api("POST", "/api/profile", body);
    fill(await api("GET", "/api/config"));
  } catch (e) {
    log("error", e.message);
  }
};
$("profile").addEventListener("change", () => profileAction({ action: "switch", file: $("profile").value }));
// ---- the page's own dialog (the browser's prompt() and confirm() would be titled with the API's address) ----
/**
 * Asks a question in the dialog. With `value`, a text field holds it, pre-selected, and the answer is the text typed
 * (Enter confirms); without, the answer is true. Cancel, Escape or a dialog that's already open give null.
 */
const ask = ({ title, message, value, ok = "OK", danger = false, cancel = true }) =>
  new Promise((resolve) => {
    const dialog = $("dialog");
    if (dialog.open) {
      resolve(null);
      return;
    }
    const input = $("dialogInput");
    $("dialogTitle").textContent = title;
    $("dialogMessage").textContent = message;
    input.hidden = value === undefined;
    input.value = value ?? "";
    $("dialogCancel").hidden = !cancel; // an error has nothing to cancel
    $("dialogOk").textContent = ok;
    $("dialogOk").classList.toggle("danger", danger);
    $("dialogOk").classList.toggle("primary", !danger);
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "ok") {
          resolve(null);
        } else if (value === undefined) {
          resolve(true);
        } else {
          resolve(input.value);
        }
      },
      { once: true },
    );
    dialog.returnValue = ""; // close() without a value keeps the last one
    dialog.showModal();
    if (value !== undefined) {
      input.select();
    }
  });
$("dialogCancel").addEventListener("click", () => $("dialog").close());

const PROFILE_DIALOGS = { new: ["New profile", "Create"], duplicate: ["Duplicate profile", "Duplicate"], rename: ["Rename profile", "Rename"] };
globalThis.askProfile = async (action, suggested) => {
  if (action === "delete") {
    const message = `Delete the profile "${suggested}"? This can't be undone.`;
    if (await ask({ title: "Delete profile", message, ok: "Delete", danger: true })) {
      profileAction({ action });
    }
    return;
  }
  const [title, ok] = PROFILE_DIALOGS[action];
  const name = await ask({ title, message: "Profile name", value: suggested, ok });
  if (name?.trim()) {
    profileAction({ action, name: name.trim() });
  }
};
globalThis.confirmRestore = async () => {
  if (queueProblem) {
    await ask({ title: "Restore backups", message: `${queueProblem}.`, cancel: false });
    return;
  }
  const message = `Restore all backups under "${$("rjPath").value}"? Translated files go back to their originals.`;
  if (await ask({ title: "Restore backups", message, ok: "Restore", danger: true })) {
    api("POST", "/api/restore-backups").catch((e) => log("error", e.message));
  }
};
// The window was closed while busy (`reason`, e.g. "a translation is running"); the server exits on the yes
globalThis.confirmQuit = async (reason) => {
  const message = `${reason[0].toUpperCase()}${reason.slice(1)}. Quitting stops it.`;
  if (await ask({ title: "Quit?", message, ok: "Stop and quit", danger: true })) {
    api("POST", "/api/quit").catch(() => {});
  }
};
// A folder dropped on the window: the host sees the drop (this page can't read paths) and sets it here
globalThis.setQueueFolder = (folder) => {
  $("rjPath").value = folder;
  log("info", `Queue directory set to ${folder}`);
  save();
};

// ---- run / stop / progress ----
let running = false; // as of the last poll; the one button stops the run while there is one, else starts one
let queueProblem = ""; // as of the last poll: why the queue directory can't be used, or ""
const scanTitle = $("scan").title; // what Scan does; replaced by the reason while it's disabled
$("run").addEventListener("click", async () => {
  try {
    if (running) {
      await api("POST", "/api/stop");
      return;
    }
    clearTimeout(saveTimer);
    await api("POST", "/api/config", read());
    await api("POST", "/api/start");
  } catch (e) {
    log("error", e.message);
  }
});
// Inspects the queue without translating; the Start button turns into Stop meanwhile
$("scan").addEventListener("click", async () => {
  try {
    clearTimeout(saveTimer);
    await api("POST", "/api/config", read());
    await api("POST", "/api/scan");
  } catch (e) {
    log("error", e.message);
  }
});
$("installSeconv").addEventListener("click", async () => {
  try {
    // resolves when seconv is installed; progress shows up in the console
    setSeconvFound((await api("POST", "/api/install-seconv")).seconvFound);
  } catch (e) {
    log("error", e.message);
  }
});
/** `ms` as m:ss, or h:mm:ss from an hour on */
const elapsed = (ms) => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
};

let since = 0;
let wasInstalling = false;
const poll = async () => {
  try {
    const s = await api("GET", `/api/state?since=${since}`);
    s.logs.forEach((l) => {
      log(l.level, l.text, l.time);
      since = l.id;
    });
    // A run first sets up (its phase), then inspects every pending file (muted bar), then translates (accent bar).
    // Under the bar: the phase or the percentage on the left, the counts, elapsed time and ETA on the right.
    const inspecting = s.running && s.inspected < s.toInspect;
    let pct = 0;
    let phase = "";
    let status = "";
    if (s.running && s.phase) {
      phase = s.phase;
    } else if (inspecting) {
      pct = Math.round((s.inspected / s.toInspect) * 100);
      phase = `Inspecting ${s.inspected} / ${s.toInspect} files`;
    } else if (s.scanOnly && !s.running) {
      phase = "Scanned";
      status = `${s.filesTotal} files · ${s.total} lines to translate`;
    } else if (s.total) {
      pct = Math.round((s.done / s.total) * 100);
      phase = `${pct}%`;
      status = `${s.filesDone} / ${s.filesTotal} files · ${s.done} / ${s.total} lines`;
    }
    const done = !s.running && s.total > 0 && s.done >= s.total;
    if (done) {
      phase = "Done";
    }
    if (s.startedAt) {
      // The run's elapsed time (frozen once it's over), then the ETA: lines per second since the first file started,
      // once two files or a tenth of the lines are done, so that one file's pace doesn't set it
      const parts = [];
      if (status) {
        parts.push(status);
      }
      parts.push(elapsed((s.finishedAt || Date.now()) - s.startedAt));
      if (s.running && !inspecting && s.translatingAt && s.done > 0 && (s.filesDone >= 2 || s.done >= s.total / 10)) {
        const linesPerMs = s.done / (Date.now() - s.translatingAt);
        parts.push(`ETA ${elapsed((s.total - s.done) / linesPerMs)}`);
      }
      status = parts.join(" · ");
    }
    $("progress").hidden = !s.startedAt; // no bar until there has been a run; afterwards it stays as the summary
    $("bar").style.width = `${pct}%`;
    $("progress").classList.toggle("inspecting", inspecting);
    $("progress").classList.toggle("done", done);
    $("phase").textContent = phase;
    $("status").textContent = status;
    setSeconvFound(s.seconvFound);
    // The queue fields are required. The saved directory is checked on every poll, so creating or renaming it outside
    // the app shows at once
    let queueHint = "";
    queueProblem = "";
    if (!$("rjPath").value.trim()) {
      queueHint = "Required";
      queueProblem = "The queue directory is required";
    } else if (!s.queueFound) {
      queueHint = "Folder not found";
      queueProblem = "The queue directory was not found";
    }
    $("rjPathError").textContent = queueHint;
    $("rjPathError").hidden = !queueHint;
    $("rjPath").classList.toggle("error", queueHint !== "");
    const noExtensions = chips(extensionsList).length === 0;
    $("extensionsError").hidden = !noExtensions;
    extensionsList.classList.toggle("error", noExtensions);
    // Another profile was loaded (the dropdown, or a menu action): show its settings
    if (s.load !== shownLoad) {
      api("GET", "/api/config")
        .then(fill)
        .catch((e) => log("error", e.message));
    }
    // An install brings that seconv's language list; watched here so the menu's "Update seconv" is covered too
    if (wasInstalling && !s.installing) {
      api("GET", "/api/config")
        .then((d) => fillLanguages(d.languages, read()))
        .catch((e) => log("error", e.message));
    }
    wasInstalling = s.installing;
    const busy = s.running || s.installing || s.restoring;
    // A run's pill: its set-up phase while there is one, then what the counts say
    let pill = "Idle";
    if (s.running) {
      if (s.phase) {
        pill = s.phase;
      } else if (inspecting) {
        pill = "Inspecting";
      } else {
        pill = "Translating";
      }
    } else if (s.installing) {
      pill = "Downloading";
    } else if (s.restoring) {
      pill = "Restoring";
    }
    $("pill").textContent = pill;
    $("pill").classList.toggle("running", s.running);
    running = s.running;
    $("run").textContent = running ? "Stop" : "Start translation";
    $("run").classList.toggle("danger", running);
    $("run").classList.toggle("primary", !running);
    // Why Start and Scan can't be clicked, as their tooltip
    let blocked = "";
    if (s.installing) {
      blocked = "A download is running";
    } else if (s.restoring) {
      blocked = "Backups are being restored";
    } else if (seconvMissing) {
      blocked = "seconv was not found";
    } else if (queueProblem) {
      blocked = queueProblem;
    } else if (noExtensions) {
      blocked = "At least one file extension is required";
    }
    $("run").disabled = !running && blocked !== "";
    $("run").title = $("run").disabled ? blocked : "";
    $("scan").disabled = running || blocked !== "";
    $("scan").title = blocked || scanTitle;
    // A run reads the settings as it goes, so they're locked until it's over (the server refuses a profile switch too)
    $("settings").disabled = busy;
    $("profile").disabled = busy;
    $("installSeconv").disabled = busy;
    $("installSeconv").textContent = s.installing ? "Downloading…" : "Download latest pre-release";
  } catch {
    /* server not ready yet */
  }
  setTimeout(poll, 500);
};

api("GET", "/api/config").then(fill).then(poll);
