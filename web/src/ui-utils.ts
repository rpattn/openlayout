export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '\"': "&quot;",
  })[character]!);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function formatNumber(value: number, maximumFractionDigits = 3): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(maximumFractionDigits).replace(/0+$/, "").replace(/\.$/, "");
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
