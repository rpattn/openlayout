import { linearDimensionMarkup } from "./cad-dimensions";
import { rotateVector, type Bounds } from "./cad-geometry";
import type { CadView } from "./cad-interaction";
import type { CadSelection } from "./cad-selection";
import { clamp, escapeHtml, formatNumber } from "./ui-utils";
import { transformPoint } from "./problem";
import type { CadDimension, DraftingPath, EditorState, Point } from "./types";

type SceneSelection = Exclude<CadSelection, { kind: "placement" }>;
type SelectionPredicate = (selection: SceneSelection) => boolean;

export interface DraftingMarkupContext {
  state: EditorState;
  view: CadView;
  isSelected: SelectionPredicate;
  isLocked: SelectionPredicate;
}

export function traceImageMarkup(state: EditorState): string {
  return state.drafting.traceImages.map((trace) => trace.visible === false ? "" : `<g transform="translate(${trace.x} ${-trace.y}) rotate(${-trace.rotation})"><image class="cad-trace-image" href="${escapeHtml(trace.dataUrl)}" x="${-trace.width / 2}" y="${-trace.height / 2}" width="${trace.width}" height="${trace.height}" opacity="${clamp(trace.opacity, 0, 1)}" preserveAspectRatio="none"/></g>`).join("");
}

export function traceImageHitMarkup({ state, isLocked, isSelected }: DraftingMarkupContext): string {
  return state.drafting.traceImages.map((trace, index) => trace.visible === false || isLocked({ kind: "trace", index }) ? "" : `<rect data-cad-kind="trace" data-cad-index="${index}" class="cad-trace-hit ${isSelected({ kind: "trace", index }) ? "selected" : ""}" transform="translate(${trace.x} ${-trace.y}) rotate(${-trace.rotation})" x="${-trace.width / 2}" y="${-trace.height / 2}" width="${trace.width}" height="${trace.height}"/>`).join("");
}

export function draftingMarkup({ state, view, isLocked, isSelected }: DraftingMarkupContext): string {
  const reach = Math.hypot(view.width, view.height) * 2;
  const guides = state.drafting.guides.map((guide, index) => {
    const vector = rotateVector({ x: reach, y: 0 }, guide.rotation), selected = isSelected({ kind: "guide", index });
    const coordinates = `x1="${guide.x - vector.x}" y1="${-(guide.y - vector.y)}" x2="${guide.x + vector.x}" y2="${-(guide.y + vector.y)}"`;
    const hit = isLocked({ kind: "guide", index }) ? "" : `<line data-cad-kind="guide" data-cad-index="${index}" class="cad-construction-guide" ${coordinates}/>`;
    return `<line class="cad-guide-visual ${selected ? "selected" : ""}" ${coordinates}/>${hit}`;
  }).join("");
  const shapes = state.drafting.shapes.map((shape, index) => {
    const points = draftingWorldPoints(shape), d = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${point.x},${-point.y}`).join(" ") + (shape.closed ? " Z" : "");
    const locked = isLocked({ kind: "drafting", index }), selected = isSelected({ kind: "drafting", index });
    const hit = locked ? "" : `<path data-cad-kind="drafting" data-cad-index="${index}" class="cad-drafting-hit" d="${d}"/>`;
    return `<path class="cad-drafting-shape ${locked ? "locked" : selected ? "selected" : ""}" d="${d}"/>${hit}`;
  }).join("");
  const texts = state.drafting.texts.map((entry, index) => {
    const bounds = draftingTextLocalBounds(entry), locked = isLocked({ kind: "text", index });
    const lines = entry.text.split("\n");
    const family = entry.fontFamily === "sans" ? "system-ui, sans-serif" : entry.fontFamily === "serif" ? "Georgia, serif" : 'ui-monospace, "SFMono-Regular", Consolas, monospace';
    const anchor = entry.align === "center" ? "middle" : entry.align === "right" ? "end" : "start";
    const visual = `<text class="cad-scene-text" text-anchor="${anchor}" style="font-size:${entry.fontSize}px;fill:${escapeHtml(entry.color)};font-family:${family};font-weight:${entry.bold ? 700 : 400};font-style:${entry.italic ? "italic" : "normal"};text-decoration:${entry.underline ? "underline" : "none"}">${lines.map((line, lineIndex) => `<tspan x="0" dy="${lineIndex ? 1.2 : 0}em">${escapeHtml(line || " ")}</tspan>`).join("")}</text>`;
    const hit = locked ? "" : `<rect data-cad-kind="text" data-cad-index="${index}" class="cad-text-hit ${isSelected({ kind: "text", index }) ? "selected" : ""}" x="${bounds.minX}" y="${-bounds.maxY}" width="${bounds.width}" height="${bounds.height}"/>`;
    return `<g transform="translate(${entry.x} ${-entry.y}) rotate(${-entry.rotation})">${visual}${hit}</g>`;
  }).join("");
  return `<g class="cad-construction-guides">${guides}${shapes}${texts}</g>`;
}

export function draftPreviewMarkup(tool: "line" | "polyline" | null, points: Point[], hover: Point | null, scale: number): string {
  if (!tool || !hover) return "";
  const allPoints = [...points, hover];
  const preview = points.length ? `<polyline class="cad-draft-preview" points="${allPoints.map((entry) => `${entry.x},${-entry.y}`).join(" ")}"/>` : "";
  const cursor = Math.max(5 * scale, .1), crosshair = Math.max(8 * scale, .16), label = Math.max(9 * scale, .18);
  return `${preview}<g class="cad-draft-cursor"><circle cx="${hover.x}" cy="${-hover.y}" r="${cursor}"/><line x1="${hover.x - crosshair}" y1="${-hover.y}" x2="${hover.x + crosshair}" y2="${-hover.y}"/><line x1="${hover.x}" y1="${-hover.y - crosshair}" x2="${hover.x}" y2="${-hover.y + crosshair}"/><text x="${hover.x + label}" y="${-hover.y - label}">${formatNumber(hover.x, 2)}, ${formatNumber(hover.y, 2)}</text></g>`;
}

export function guidePreviewMarkup(rotation: number | null, hover: Point | null, view: CadView, scale: number): string {
  if (rotation === null || !hover) return "";
  const reach = Math.hypot(view.width, view.height) * 2, vector = rotateVector({ x: reach, y: 0 }, rotation), radius = Math.max(5 * scale, .1), label = Math.max(9 * scale, .18);
  return `<g class="cad-guide-placement-preview"><line x1="${hover.x - vector.x}" y1="${-(hover.y - vector.y)}" x2="${hover.x + vector.x}" y2="${-(hover.y + vector.y)}"/><circle cx="${hover.x}" cy="${-hover.y}" r="${radius}"/><text x="${hover.x + label}" y="${-hover.y - label}">${formatNumber(hover.x, 2)}, ${formatNumber(hover.y, 2)}</text></g>`;
}

export function dimensionPreviewMarkup(active: boolean, points: Point[], hover: Point | null, scale: number, settings: EditorState["viewSettings"]): string {
  if (!active || !hover) return "";
  const radius = Math.max(5 * scale, .1), crosshair = Math.max(8 * scale, .16), label = Math.max(9 * scale, .18);
  const cursor = `<g class="cad-draft-cursor cad-dimension-cursor"><circle cx="${hover.x}" cy="${-hover.y}" r="${radius}"/><line x1="${hover.x - crosshair}" y1="${-hover.y}" x2="${hover.x + crosshair}" y2="${-hover.y}"/><line x1="${hover.x}" y1="${-hover.y - crosshair}" x2="${hover.x}" y2="${-hover.y + crosshair}"/><text x="${hover.x + label}" y="${-hover.y - label}">${formatNumber(hover.x, 2)}, ${formatNumber(hover.y, 2)}</text></g>`;
  if (!points.length) return cursor;
  const preview: CadDimension = { id: "preview", start: points[0], end: hover, offset: { x: 0, y: 0 }, textOverride: "" };
  return `<g class="cad-dimension-preview">${linearDimensionMarkup(preview, scale, settings)}</g>${cursor}`;
}

export function draftingWorldPoints(shape: DraftingPath): Point[] {
  return shape.points.map((point) => transformPoint(point, shape.rotation, shape.x, shape.y));
}

export function draftingTextLocalBounds(entry: EditorState["drafting"]["texts"][number]): Bounds {
  const lines = entry.text.split("\n"), longest = Math.max(1, ...lines.map((line) => [...line].length));
  const width = Math.max(entry.fontSize * .62 * longest, entry.fontSize * .5), minY = -(lines.length - 1) * entry.fontSize * 1.2 - entry.fontSize * .25, maxY = entry.fontSize;
  const minX = entry.align === "center" ? -width / 2 : entry.align === "right" ? -width : 0, maxX = minX + width;
  return { minX, minY, maxX, maxY, width, height: maxY - minY };
}
