import { escapeHtml } from "./ui-utils";

type ShortcutGroup = "Navigate" | "Edit" | "View" | "Run";
interface Shortcut { keys: string[]; label: string; group: ShortcutGroup }

const GROUPS: ShortcutGroup[] = ["Navigate", "Edit", "View", "Run"];
const SHORTCUTS: Shortcut[] = [
  { keys: ["?"], label: "Show keyboard shortcuts", group: "Navigate" },
  { keys: ["1"], label: "Open workspace", group: "Navigate" },
  { keys: ["2"], label: "Open sensitivity", group: "Navigate" },
  { keys: ["Esc"], label: "Close menu or dialog", group: "Navigate" },
  { keys: ["Ctrl/⌘", "Z"], label: "Undo", group: "Edit" },
  { keys: ["Ctrl/⌘", "Shift", "Z"], label: "Redo", group: "Edit" },
  { keys: ["Ctrl/⌘", "C"], label: "Copy selection", group: "Edit" },
  { keys: ["Ctrl/⌘", "V"], label: "Paste selection", group: "Edit" },
  { keys: ["Ctrl/⌘", "D"], label: "Duplicate selection", group: "Edit" },
  { keys: ["Delete"], label: "Delete selection", group: "Edit" },
  { keys: ["F"], label: "Fit workspace", group: "View" },
  { keys: ["Shift", "F"], label: "Focus selection", group: "View" },
  { keys: ["D"], label: "Toggle dimensions", group: "View" },
  { keys: ["G"], label: "Toggle constraints", group: "View" },
  { keys: ["P"], label: "Toggle problem panel", group: "View" },
  { keys: ["+"], label: "Zoom in", group: "View" },
  { keys: ["−"], label: "Zoom out", group: "View" },
  { keys: ["R"], label: "Run packing or study", group: "Run" },
  { keys: ["V"], label: "Validate problem", group: "Run" },
  { keys: ["E"], label: "Open export options", group: "Run" },
  { keys: ["Ctrl/⌘", "S"], label: "Save project", group: "Run" },
];

export function shortcutsMarkup(): string {
  return GROUPS.map((group) => `<section><h3>${group}</h3>${SHORTCUTS
    .filter((entry) => entry.group === group)
    .map((entry) => `<div><span>${escapeHtml(entry.label)}</span><kbd>${entry.keys.map(escapeHtml).join("</kbd><kbd>")}</kbd></div>`)
    .join("")}</section>`).join("");
}
