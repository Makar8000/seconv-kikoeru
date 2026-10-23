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
  if (!res.ok) throw new Error(data.error);
  return data;
};

const log = (level, text) => {
  const c = $("console");
  const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 5;
  const line = document.createElement("div");
  line.className = level;
  line.textContent = text;
  c.append(line);
  if (stick) c.scrollTop = c.scrollHeight;
};
$("clear").addEventListener("click", () => $("console").replaceChildren());

// ---- config: every edit is saved automatically ----
// Model / URL / extra args belong to the selected engine: the fields show that engine's settings, and the
// other engines' settings are held in `engines` untouched until the engine is switched.
const isEngine = (el) => "engine" in el.dataset;
const chips = (l) => [...l.querySelectorAll(".chip")].map((c) => c.dataset.value);
let engines = {};
let shownEngine = "";

const readEngine = () => ({
  ...Object.fromEntries(inputs.filter(isEngine).map((f) => [f.dataset.key, f.value])),
  ...Object.fromEntries(lists.filter(isEngine).map((l) => [l.dataset.list, chips(l)])),
});

const read = () => ({
  ...Object.fromEntries(inputs.filter((f) => !isEngine(f)).map((f) => [f.dataset.key, f.value])),
  ...Object.fromEntries(lists.filter((l) => !isEngine(l)).map((l) => [l.dataset.list, chips(l)])),
  engines: { ...engines, [shownEngine]: readEngine() },
});

let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { config } = await api("POST", "/api/config", read());
      // Show anything the server corrected (e.g. a blank required field), without touching the field being edited
      inputs.forEach((f) => {
        if (f !== document.activeElement) f.value = (isEngine(f) ? config.engines[shownEngine] : config)?.[f.dataset.key] ?? "";
      });
    } catch (e) {
      log("error", e.message);
    }
  }, 300);
};

// ---- chip lists (additional args, file extensions) ----
const addChip = (l, value) => {
  value = value.trim();
  if (!value || [...l.querySelectorAll(".chip")].some((c) => c.dataset.value === value)) return false;
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
    if (addChip(l, input.value)) save();
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
  values.forEach((v) => addChip(l, v));
};

// seconv must be on the PATH; the server tells us whether it is
let seconvMissing = false;

const setSeconvFound = (found) => {
  seconvMissing = !found;
  $("seconvNotice").hidden = found;
};

const showEngine = () => {
  const e = engines[shownEngine] ?? { model: "", url: "", additionalArgs: [] };
  inputs.filter(isEngine).forEach((f) => f.value = e[f.dataset.key]);
  lists.filter(isEngine).forEach((l) => renderList(l, e[l.dataset.list]));
};

// ---- dropdowns ----
const fillSelect = (select, options, current) => {
  // Keep a hand-edited value that isn't in the known list selectable
  const known = options.some((o) => o.value === current);
  const all = known || !current ? options : [...options, { value: current, label: current }];
  select.replaceChildren(...all.map((o) => new Option(o.label, o.value)));
  select.value = current;
};

const fill = ({ config, engines: engineNames, languages, seconvFound }) => {
  setSeconvFound(seconvFound);
  fillSelect($("translateEngine"), engineNames.map((e) => ({ value: e, label: e })), config.translateEngine);
  const langs = languages.map((l) => ({ value: l.code, label: `${l.name} (${l.code})` }));
  fillSelect($("translateFrom"), [{ value: "", label: "Auto-detect" }, ...langs], config.translateFrom);
  fillSelect($("translateTo"), langs, config.translateTo);
  inputs.filter((f) => f.tagName !== "SELECT" && !isEngine(f)).forEach((f) => f.value = config[f.dataset.key]);
  lists.filter((l) => !isEngine(l)).forEach((l) => renderList(l, config[l.dataset.list]));
  engines = structuredClone(config.engines);
  shownEngine = config.translateEngine;
  showEngine();
};

inputs.forEach((f) => f.addEventListener(f.tagName === "SELECT" ? "change" : "input", save));
$("translateEngine").addEventListener("change", () => {
  engines[shownEngine] = readEngine(); // keep what was typed for the engine we're leaving
  shownEngine = $("translateEngine").value;
  showEngine();
});

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
    $("status").textContent = s.total ? `${s.done} / ${s.total}` : "";
    setSeconvFound(s.seconvFound);
    const busy = s.running || s.installing || s.restoring;
    $("pill").textContent = s.running ? "Running" : s.installing ? "Downloading" : s.restoring ? "Restoring" : "Idle";
    $("pill").classList.toggle("running", s.running);
    $("start").disabled = busy || seconvMissing;
    $("installSeconv").disabled = busy;
    $("installSeconv").textContent = s.installing ? "Downloading…" : "Download latest pre-release";
    $("stop").hidden = !s.running;
  } catch { /* server not ready yet */ }
  setTimeout(poll, 500);
};

api("GET", "/api/config").then(fill).then(poll);
