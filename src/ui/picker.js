// The path picker: a file-browser dialog over GET /api/paths (src/paths.ts), behind the queue directory's Browse button.
// No OS dialog (Windows records a picker's folders in the registry), nothing stored. Uses app.js's `$`, `api` and `setQueueFolder`.

const PICKER_LABELS = {
  pick: "Select",
  cancel: "Cancel",
  roots: "This PC",
  places: "Drives",
  name: "Name",
  empty: "This folder is empty",
  nothing: "Nothing selected",
  folders: "folders",
  files: "files",
};
const PICKER_TITLES = { folder: "Select a folder", file: "Select a file", any: "Select a file or folder" };
const PICKER_PICKS = { folder: "Select folder", file: "Select file", any: "Select" };
// Inline 16px icons in currentColor
const PICKER_ICONS = {
  up: '<svg viewBox="0 0 16 16"><path d="M8 2.5l5 5-1.4 1.4L9 6.3V13.5H7V6.3L4.4 8.9 3 7.5z"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16"><path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1l1.6 1.5H13A1.5 1.5 0 0 1 14.5 5.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3.5 3.5v8A1.5 1.5 0 0 1 11 14.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5zM9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  drive:
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="8" r="1.1"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

const listPaths = (path) => api("GET", `/api/paths?path=${encodeURIComponent(path)}`);

const el = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
};
const icon = (name) => {
  const span = el("span", "picker-icon");
  span.innerHTML = PICKER_ICONS[name];
  return span;
};
const button = (className, text = "") => {
  const node = el("button", className, text);
  node.type = "button";
  return node;
};

/** The crumbs of `path`: the drive (or "/") then one per folder, each with its path; none for the roots. */
const crumbsOf = (path) => {
  const crumbs = [];
  if (!path) {
    return crumbs;
  }
  const windows = path.includes("\\");
  const sep = windows ? "\\" : "/";
  let acc = "";
  if (!windows) {
    acc = "/";
    crumbs.push({ label: "/", path: "/" });
  }
  for (const part of path.split(sep).filter(Boolean)) {
    if (windows && !acc) {
      acc = `${part}\\`; // the drive
      crumbs.push({ label: acc, path: acc });
      continue;
    }
    acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
};

/**
 * Opens the picker; resolves with the chosen absolute path, or null when cancelled.
 * - mode: "folder" (the open folder), "file" (the selected file) or "any" (the selected file, else the open folder)
 * - start: the first folder; the roots when empty or unreadable
 * - title, labels (pick, cancel, roots, places, name, empty, nothing, folders, files), className: an extra class on the dialog
 * - list: path => Promise<listing> (src/paths.ts); default GET /api/paths
 */
const pickPath = ({ mode = "any", start = "", title = PICKER_TITLES[mode], labels = {}, className = "", list = listPaths } = {}) =>
  new Promise((resolve) => {
    const text = { ...PICKER_LABELS, pick: PICKER_PICKS[mode], ...labels };
    const dialog = el("dialog", `picker ${className}`.trim());
    const form = el("form");
    form.method = "dialog";
    const close = button("picker-close");
    close.append(icon("close"));
    close.title = text.cancel;
    const up = button("picker-up");
    up.append(icon("up"));
    up.title = "Up";
    const crumbs = el("div", "picker-crumbs");
    crumbs.title = "Click to type a path";
    const where = el("input", "picker-path");
    where.autocomplete = "off";
    where.spellcheck = false;
    where.hidden = true;
    const bar = el("div", "picker-bar");
    bar.append(crumbs, where);
    const places = el("div", "picker-places");
    const head = el("div", "picker-head");
    const headName = el("span", "", text.name);
    const counts = el("span", "picker-counts");
    head.append(headName, counts);
    const items = el("div", "picker-list");
    items.tabIndex = -1; // so the arrow keys work before a row has focus
    const note = el("div", "picker-note");
    const selection = el("span", "picker-selection");
    const cancel = button("", text.cancel);
    const pick = el("button", "primary", text.pick);
    pick.type = "submit";
    pick.value = "ok";

    let current = { path: "", parent: null, entries: [] };
    let selected = null;
    // What Select returns: the selected file, else the open folder (never the roots list)
    const choice = () => {
      if (selected) {
        return selected.path;
      }
      return mode === "file" ? "" : current.path;
    };
    const showChoice = () => {
      const path = choice();
      selection.replaceChildren(el("bdi", "", path || text.nothing)); // bdi: the path reads left to right inside the rtl box
      selection.title = path;
      selection.classList.toggle("muted", !path);
      pick.disabled = !path;
    };
    const select = (entry, row) => {
      selected = entry;
      for (const other of items.children) {
        other.classList.toggle("selected", other === row);
      }
      showChoice();
    };
    // A folder opens; a file is the choice, confirmed right away
    const activate = (entry) => {
      if (entry.kind === "folder") {
        open(entry.path);
      } else if (mode !== "folder") {
        selected = entry;
        dialog.close("ok");
      }
    };
    const render = () => {
      crumbs.replaceChildren();
      for (const crumb of crumbsOf(current.path)) {
        const step = button("picker-crumb", crumb.label);
        step.addEventListener("click", () => open(crumb.path));
        crumbs.append(step);
      }
      crumbs.lastElementChild?.classList.add("current");
      // A long path: the crumbs after the drive collapse into "…" until the bar fits
      if (crumbs.scrollWidth > crumbs.clientWidth && crumbs.children.length > 3) {
        const more = button("picker-crumb picker-more", "…");
        more.title = "Click to type a path";
        more.addEventListener("click", editPath);
        crumbs.children[1].before(more);
        while (crumbs.scrollWidth > crumbs.clientWidth && crumbs.children.length > 3) {
          crumbs.children[2].remove();
        }
      }
      up.disabled = current.parent === null;
      for (const place of places.querySelectorAll(".picker-place")) {
        place.classList.toggle("active", current.path.startsWith(place.dataset.path));
      }
      items.replaceChildren();
      let folders = 0;
      for (const entry of current.entries) {
        const row = button(`picker-row picker-${entry.kind}`);
        row.append(icon(entry.kind), el("span", "picker-name", entry.name));
        row.title = entry.path;
        if (entry.kind === "folder") {
          folders++;
        } else if (mode === "folder") {
          row.disabled = true; // shown for recognition, not selectable
        }
        if (entry.kind === "folder") {
          row.addEventListener("click", () => open(entry.path));
        } else {
          row.addEventListener("click", () => select(entry, row));
          row.addEventListener("dblclick", () => activate(entry));
        }
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault(); // Enter opens a folder or confirms a file; Space selects
            activate(entry);
          }
        });
        items.append(row);
      }
      counts.textContent = `${folders} ${text.folders} · ${current.entries.length - folders} ${text.files}`;
      note.textContent = current.error ?? (current.entries.length ? "" : text.empty);
      note.classList.toggle("error", Boolean(current.error));
      items.classList.toggle("empty", !current.entries.length);
      showChoice();
    };
    const open = async (path) => {
      selected = null;
      dialog.classList.add("loading");
      try {
        current = await list(path);
      } catch (e) {
        current = { path, parent: "", entries: [], error: e.message };
      }
      dialog.classList.remove("loading");
      render();
      items.focus();
    };
    const editPath = () => {
      where.value = current.path;
      where.hidden = false;
      crumbs.hidden = true;
      where.focus();
      where.select();
    };
    const endEdit = () => {
      where.hidden = true;
      crumbs.hidden = false;
    };

    // The drives, fetched once
    list("")
      .then((roots) => {
        places.append(el("div", "picker-places-title", text.places));
        for (const root of roots.entries) {
          const place = button("picker-place");
          place.dataset.path = root.path;
          place.append(icon("drive"), el("span", "picker-name", root.name));
          place.addEventListener("click", () => open(root.path));
          places.append(place);
        }
        render();
      })
      .catch(() => {});
    crumbs.addEventListener("click", (e) => {
      if (e.target === crumbs) {
        editPath();
      }
    });
    crumbs.addEventListener("dblclick", editPath);
    where.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault(); // not a submit: go to the typed path
        endEdit();
        open(where.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault(); // not a cancel of the dialog
        endEdit();
      }
    });
    where.addEventListener("blur", endEdit);
    up.addEventListener("click", () => open(current.parent ?? ""));
    items.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = [...items.querySelectorAll("button:not(:disabled)")];
        rows[rows.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
      } else if (e.key === "Backspace" && current.parent !== null) {
        open(current.parent);
      }
    });
    cancel.addEventListener("click", () => dialog.close());
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "ok" ? choice() : null);
    });

    const tools = el("div", "picker-tools");
    tools.append(up, bar);
    const main = el("div", "picker-main");
    main.append(head, items, note);
    const body = el("div", "picker-body");
    body.append(places, main);
    const actions = el("div", "picker-actions");
    actions.append(cancel, pick);
    const foot = el("div", "picker-foot");
    foot.append(selection, actions);
    const titlebar = el("div", "picker-titlebar");
    titlebar.append(el("h2", "picker-title", title), close);
    form.append(titlebar, tools, body, foot);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    open(start).then(() => {
      if (current.error && start) {
        return open("");
      }
    });
  });

$("browseQueue").addEventListener("click", async () => {
  const folder = await pickPath({ mode: "folder", start: $("rjPath").value.trim(), title: "Queue directory" });
  if (folder) {
    setQueueFolder(folder);
  }
});
