import { escapeHtml } from "./ui-utils";

export interface ToolbarPaletteOption { value: string; icon: string; label: string; detail: string }

export function toolbarPaletteHtml(id: string, label: string, icon: string, options: ToolbarPaletteOption[], selected?: string): string {
  const active = options.find((option) => option.value === selected);
  return `<div class="tool-popover" data-toolbar-palette>
    <button id="${id}" class="tool-button icon-tool" type="button" aria-label="${escapeHtml(active ? `${label}: ${active.label}` : label)}" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(active ? `${label}: ${active.label}` : label)}" data-palette-label="${escapeHtml(label)}" data-value="${escapeHtml(selected ?? "")}"><span data-toolbar-trigger-icon aria-hidden="true">${escapeHtml(active?.icon ?? icon)}</span></button>
    <div id="${id}-menu" class="toolbar-palette" role="menu" aria-label="${escapeHtml(label)}" hidden>
      ${options.map((option) => `<button type="button" role="${selected === undefined ? "menuitem" : "menuitemradio"}" ${selected === undefined ? "" : `aria-checked="${option.value === selected}"`} data-toolbar-menu-value="${escapeHtml(option.value)}" data-toolbar-menu-icon="${escapeHtml(option.icon)}" class="${option.value === selected ? "selected" : ""}"><span class="shape-menu-icon">${escapeHtml(option.icon)}</span><span><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.detail)}</small></span><span class="palette-check" aria-hidden="true">✓</span></button>`).join("")}
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

export function closeToolbarPalettes(focus = false): boolean {
  let closed = false;
  document.querySelectorAll<HTMLElement>("[data-toolbar-palette]").forEach((root) => {
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
