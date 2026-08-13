import { escapeHtml } from "./ui-utils";

export interface ToolbarPaletteOption { value: string; icon: string; label: string; detail: string }

export function toolbarActionPaletteHtml(id: string, label: string, icon: string, options: ToolbarPaletteOption[], title = `${label} · hover for actions`): string {
  return `<div class="tool-split action-palette" data-toolbar-action>
    <button id="${id}" class="tool-button icon-tool" type="button" aria-label="${escapeHtml(label)}" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(title)}"><span aria-hidden="true">${escapeHtml(icon)}</span></button>
    <div id="${id}-menu" class="toolbar-palette split-palette" role="menu" aria-label="${escapeHtml(label)} actions" hidden>
      ${options.map((option) => `<button type="button" role="menuitem" data-toolbar-menu-value="${escapeHtml(option.value)}"><span class="shape-menu-icon">${escapeHtml(option.icon)}</span><span><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.detail)}</small></span></button>`).join("")}
    </div>
  </div>`;
}

export function toolbarSplitPaletteHtml(id: string, label: string, options: ToolbarPaletteOption[], selected: string, triggerIcon?: string): string {
  const active = options.find((option) => option.value === selected) ?? options[0];
  return `<div class="tool-split" data-toolbar-split>
    <button id="${id}" class="tool-button split-main" type="button" aria-label="Add ${escapeHtml(label)} as ${escapeHtml(active.label.toLowerCase())}" aria-haspopup="menu" aria-expanded="false" title="Add ${escapeHtml(label)} as ${escapeHtml(active.label.toLowerCase())} · hover for choices" data-split-label="${escapeHtml(label)}" data-value="${escapeHtml(active.value)}" ${triggerIcon ? `data-fixed-icon="${escapeHtml(triggerIcon)}"` : ""}><span data-split-icon aria-hidden="true">${escapeHtml(triggerIcon ?? active.icon)}</span><span>${escapeHtml(label)}</span></button>
    <div id="${id}-menu" class="toolbar-palette split-palette" role="menu" aria-label="${escapeHtml(label)} shape" hidden>
      ${options.map((option) => `<button type="button" role="menuitemradio" aria-checked="${option.value === active.value}" data-toolbar-menu-value="${escapeHtml(option.value)}" data-toolbar-menu-icon="${escapeHtml(option.icon)}" class="${option.value === active.value ? "selected" : ""}"><span class="shape-menu-icon">${escapeHtml(option.icon)}</span><span><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.detail)}</small></span></button>`).join("")}
    </div>
  </div>`;
}

export function toolbarPaletteHtml(id: string, label: string, icon: string, options: ToolbarPaletteOption[], selected?: string): string {
  const active = options.find((option) => option.value === selected);
  return `<div class="tool-popover" data-toolbar-palette>
    <button id="${id}" class="tool-button icon-tool" type="button" aria-label="${escapeHtml(active ? `${label}: ${active.label}` : label)}" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(active ? `${label}: ${active.label}` : label)}" data-palette-label="${escapeHtml(label)}" data-value="${escapeHtml(selected ?? "")}"><span data-toolbar-trigger-icon aria-hidden="true">${escapeHtml(active?.icon ?? icon)}</span></button>
    <div id="${id}-menu" class="toolbar-palette" role="menu" aria-label="${escapeHtml(label)}" hidden>
      ${options.map((option) => `<button type="button" role="${selected === undefined ? "menuitem" : "menuitemradio"}" ${selected === undefined ? "" : `aria-checked="${option.value === selected}"`} data-toolbar-menu-value="${escapeHtml(option.value)}" data-toolbar-menu-icon="${escapeHtml(option.icon)}" class="${option.value === selected ? "selected" : ""}"><span class="shape-menu-icon">${escapeHtml(option.icon)}</span><span><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.detail)}</small></span></button>`).join("")}
    </div>
  </div>`;
}

export function bindToolbarPalette(id: string, onSelect: (value: string) => void, reflectSelection = false): void {
  const trigger = document.getElementById(id) as HTMLButtonElement;
  const menu = document.getElementById(`${id}-menu`)!;
  trigger.addEventListener("click", () => {
    const opening = menu.hidden;
    closeToolbarPalettes();
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) menu.querySelector<HTMLButtonElement>(".selected, button")?.focus();
  });
  menu.querySelectorAll<HTMLButtonElement>("[data-toolbar-menu-value]").forEach((button) => button.addEventListener("click", () => {
    const value = button.dataset.toolbarMenuValue!;
    if (reflectSelection) reflectPaletteSelection(menu, trigger, button, value);
    onSelect(value);
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  }));
}

export function bindToolbarSplitPalette(id: string, onAdd: (value: string) => void, onRemember: (value: string) => void): void {
  const main = document.getElementById(id) as HTMLButtonElement;
  const menu = document.getElementById(`${id}-menu`)!;
  const root = main.closest<HTMLElement>("[data-toolbar-split]")!;
  let hoverTimer = 0, suppressHover = false;
  const open = (): void => { closeToolbarPalettes(); menu.hidden = false; main.setAttribute("aria-expanded", "true"); };
  const close = (): void => { menu.hidden = true; main.setAttribute("aria-expanded", "false"); };
  root.addEventListener("mouseenter", () => { if (!suppressHover) hoverTimer = window.setTimeout(() => { if (!suppressHover) open(); }, 140); });
  root.addEventListener("mouseleave", () => { window.clearTimeout(hoverTimer); suppressHover = false; close(); });
  root.addEventListener("focusin", () => { if (!suppressHover) open(); });
  root.addEventListener("focusout", () => setTimeout(() => { if (!root.contains(document.activeElement)) close(); }));
  main.addEventListener("keydown", (event) => { if (event.key === "ArrowDown") { event.preventDefault(); open(); menu.querySelector<HTMLButtonElement>(".selected, button")?.focus(); } });
  main.addEventListener("click", () => { window.clearTimeout(hoverTimer); suppressHover = true; close(); onAdd(main.dataset.value!); });
  menu.querySelectorAll<HTMLButtonElement>("[data-toolbar-menu-value]").forEach((button) => button.addEventListener("click", () => {
    const value = button.dataset.toolbarMenuValue!;
    reflectSplitSelection(menu, main, button, value);
    onRemember(value);
    onAdd(value);
    window.clearTimeout(hoverTimer); suppressHover = true;
    menu.hidden = true;
    main.setAttribute("aria-expanded", "false");
  }));
}

export function bindToolbarActionPalette(id: string, onMain: () => void, onSelect: (value: string) => void): void {
  const main = document.getElementById(id) as HTMLButtonElement, menu = document.getElementById(`${id}-menu`)!, root = main.closest<HTMLElement>("[data-toolbar-action]")!;
  let timer = 0, suppressHover = false;
  const close = (): void => { menu.hidden = true; main.setAttribute("aria-expanded", "false"); };
  const open = (): void => { closeToolbarPalettes(); menu.hidden = false; main.setAttribute("aria-expanded", "true"); };
  root.addEventListener("mouseenter", () => { if (!suppressHover) timer = window.setTimeout(() => { if (!suppressHover) open(); }, 140); });
  root.addEventListener("mouseleave", () => { window.clearTimeout(timer); suppressHover = false; close(); });
  root.addEventListener("focusin", () => { if (!suppressHover) open(); });
  root.addEventListener("focusout", () => setTimeout(() => { if (!root.contains(document.activeElement)) close(); }));
  main.addEventListener("keydown", (event) => { if (event.key === "ArrowDown") { event.preventDefault(); open(); menu.querySelector<HTMLButtonElement>("button")?.focus(); } });
  main.addEventListener("click", () => { window.clearTimeout(timer); suppressHover = true; close(); onMain(); });
  menu.querySelectorAll<HTMLButtonElement>("[data-toolbar-menu-value]").forEach((button) => button.addEventListener("click", () => {
    window.clearTimeout(timer); suppressHover = true; close(); onSelect(button.dataset.toolbarMenuValue!);
  }));
}

export function closeToolbarPalettes(focus = false): boolean {
  let closed = false;
  document.querySelectorAll<HTMLElement>("[data-toolbar-palette], [data-toolbar-split], [data-toolbar-action]").forEach((root) => {
    const menu = root.querySelector<HTMLElement>("[role=menu]");
    const trigger = root.querySelector<HTMLButtonElement>("[aria-haspopup=menu]");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (focus && !closed) trigger?.focus();
    closed = true;
  });
  return closed;
}

function reflectSplitSelection(menu: HTMLElement, main: HTMLButtonElement, button: HTMLButtonElement, value: string): void {
  menu.querySelectorAll<HTMLButtonElement>("[data-toolbar-menu-value]").forEach((entry) => {
    const active = entry === button;
    entry.classList.toggle("selected", active);
    entry.setAttribute("aria-checked", String(active));
  });
  main.dataset.value = value;
  if (!main.dataset.fixedIcon) main.querySelector<HTMLElement>("[data-split-icon]")!.textContent = button.dataset.toolbarMenuIcon!;
  const shape = button.querySelector("strong")!.textContent!;
  const label = main.dataset.splitLabel!;
  main.setAttribute("aria-label", `Add ${label} as ${shape.toLowerCase()}`);
  main.title = `Add ${label} as ${shape.toLowerCase()}`;
}

function reflectPaletteSelection(menu: HTMLElement, trigger: HTMLButtonElement, button: HTMLButtonElement, value: string): void {
  menu.querySelectorAll<HTMLButtonElement>("[data-toolbar-menu-value]").forEach((entry) => {
    const active = entry === button;
    entry.classList.toggle("selected", active);
    entry.setAttribute("aria-checked", String(active));
  });
  trigger.dataset.value = value;
  trigger.querySelector("[data-toolbar-trigger-icon]")!.textContent = button.dataset.toolbarMenuIcon!;
  const optionLabel = button.querySelector("strong")!.textContent!;
  trigger.setAttribute("aria-label", `${trigger.dataset.paletteLabel}: ${optionLabel}`);
  trigger.title = `${trigger.dataset.paletteLabel}: ${optionLabel}`;
}
