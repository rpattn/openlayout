import { resolveGeometry } from "./geometry-resolver";
import { transformPoint } from "./problem";
import { renderLayout, type LayoutDisplayOptions } from "./renderer";
import type { PackingProblem, Placement } from "./types";
import { escapeHtml, formatNumber } from "./ui-utils";

export function downloadText(filename: string, content: string, type: string): void {
  downloadBlob(filename, new Blob([content], { type }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadLayoutPng(
  filename: string,
  problem: PackingProblem,
  placements: Placement[],
  display: LayoutDisplayOptions,
): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.style.width = "1600px";
  canvas.style.height = "1000px";
  canvas.style.position = "fixed";
  canvas.style.left = "-10000px";
  document.body.append(canvas);
  try {
    renderLayout(canvas, problem, placements, display);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) downloadBlob(filename, blob);
  } finally {
    canvas.remove();
  }
}

export function placementsCsv(placements: Placement[]): string {
  return [
    "item_id,x,y,rotation_deg,fixed",
    ...placements.map((entry) => [csvCell(entry.item_id), entry.x, entry.y, entry.rotation_deg, entry.fixed].join(",")),
  ].join("\n");
}

export function safeFilename(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "openlayout";
}

export function layoutToSvg(problem: PackingProblem, placements: Placement[]): string {
  const geometry = resolveGeometry(problem);
  const itemMap = new Map(geometry.items.map((entry) => [entry.id, entry.polygons]));
  const placed = placements.flatMap((placement) => (itemMap.get(placement.item_id) ?? [])
    .map((polygon) => polygon.map((point) => transformPoint(point, placement.rotation_deg, placement.x, placement.y))));
  const all = [...geometry.container, ...geometry.exclusions.flatMap((entry) => entry.polygons), ...placed].flat();
  if (!all.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padding = Math.max(maxX - minX, maxY - minY) * .035 + .25;
  const view = `${formatNumber(minX - padding)} ${formatNumber(-maxY - padding)} ${formatNumber(maxX - minX + padding * 2)} ${formatNumber(maxY - minY + padding * 2)}`;
  const paths = (polygons: typeof geometry.container, className: string) => polygons.map((polygon) =>
    `<polygon class="${className}" points="${polygon.map((point) => `${formatNumber(point.x)},${formatNumber(-point.y)}`).join(" ")}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}"><style>.container{fill:#202b36;stroke:#82909f}.exclusion{fill:#ee716f55;stroke:#ee716f}.item{fill:#51c6a4aa;stroke:#168b70}polygon{stroke-width:.08;vector-effect:non-scaling-stroke}</style>${paths(geometry.container, "container")}${geometry.exclusions.map((entry) => paths(entry.polygons, "exclusion")).join("")}${paths(placed, "item")}</svg>`;
}

export function shapesToSvg(problem: PackingProblem): string {
  const items = resolveGeometry(problem).items;
  let cursor = 0;
  let maxHeight = 1;
  const groups: string[] = [];
  items.forEach((item) => {
    const points = item.polygons.flat();
    if (!points.length) return;
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = maxX - minX, height = maxY - minY;
    maxHeight = Math.max(maxHeight, height);
    groups.push(`<g transform="translate(${formatNumber(cursor - minX)} ${formatNumber(maxY)})"><title>${escapeHtml(item.id)}</title>${item.polygons.map((polygon) => `<polygon points="${polygon.map((point) => `${formatNumber(point.x)},${formatNumber(-point.y)}`).join(" ")}"/>`).join("")}</g>`);
    cursor += width + Math.max(width * .2, 1);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 ${formatNumber(Math.max(cursor, 1))} ${formatNumber(maxHeight + 1)}"><style>polygon{fill:#51c6a488;stroke:#168b70;stroke-width:.06;vector-effect:non-scaling-stroke}</style>${groups.join("")}</svg>`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
