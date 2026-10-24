const $ = (id) => document.getElementById(id);
const inputs = [...document.querySelectorAll("[data-key]")];
const lists = [...document.querySelectorAll("[data-list]")];

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

const log = (level, text) => {
  const c = $("console");
  const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 5;
  const line = document.createElement("div");
  line.className = level;
  line.textContent = text;
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

let saveTimer;
const save = () => {
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
  input.placeholder = l.dataset.placeholder;
  input.spellcheck = false;
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

const showEngine = () => {
  const e = engines[shownEngine] ?? { model: "", url: "", apiKey: "", prompt: "", additionalArgs: [] };
  for (const f of inputs.filter(isEngine)) {
    setValue(f, e[f.dataset.key]);
  }
  for (const l of lists.filter(isEngine)) {
    renderList(l, e[l.dataset.list]);
  }
  syncPromptToggle();
  // llama.cpp: the app uses a llama.cpp server running at the URL, or starts one there; other engines fall back to
  // seconv's default URL
  const llamaCpp = shownEngine === "llamacpp";
  $("translateUrl").placeholder = llamaCpp
    ? "http://127.0.0.1:8080/ (a llama.cpp server is started here if none is running)"
    : "Leave empty to use seconv's default";
  $("translateModel").placeholder = llamaCpp ? "Hugging Face link, user/repo:quant, or a .gguf in lib/llama.cpp/models" : "First available";
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
globalThis.askProfile = (action, suggested) => {
  if (action === "delete") {
    if (confirm(`Delete the profile "${suggested}"? This can't be undone.`)) {
      profileAction({ action });
    }
    return;
  }
  const name = prompt("Profile name:", suggested);
  if (name?.trim()) {
    profileAction({ action, name: name.trim() });
  }
};
globalThis.confirmRestore = () => {
  if (confirm(`Restore all backups under "${$("rjPath").value}"? Translated files go back to their originals.`)) {
    api("POST", "/api/restore-backups").catch((e) => log("error", e.message));
  }
};

// ---- run / stop / progress ----
$("start").addEventListener("click", async () => {
  try {
    clearTimeout(saveTimer);
    await api("POST", "/api/config", read());
    await api("POST", "/api/start");
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
$("stop").addEventListener("click", () => api("POST", "/api/stop").catch((e) => log("error", e.message)));

let since = 0;
let wasInstalling = false;
const poll = async () => {
  try {
    const s = await api("GET", `/api/state?since=${since}`);
    s.logs.forEach((l) => {
      log(l.level, l.text);
      since = l.id;
    });
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    $("bar").style.width = `${pct}%`;
    $("progress").classList.toggle("done", !s.running && s.total > 0 && s.done >= s.total);
    $("status").textContent = s.total ? `${s.filesDone} / ${s.filesTotal} files, ${s.done} / ${s.total} lines` : "";
    setSeconvFound(s.seconvFound);
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
    $("pill").textContent = s.running ? "Running" : s.installing ? "Downloading" : s.restoring ? "Restoring" : "Idle";
    $("pill").classList.toggle("running", s.running);
    $("start").disabled = busy || seconvMissing;
    $("installSeconv").disabled = busy;
    $("installSeconv").textContent = s.installing ? "Downloading…" : "Download latest pre-release";
    $("stop").hidden = !s.running;
  } catch {
    /* server not ready yet */
  }
  setTimeout(poll, 500);
};

api("GET", "/api/config").then(fill).then(poll);
