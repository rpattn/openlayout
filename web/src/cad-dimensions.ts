import type { Bounds } from "./cad-geometry";
import type { CadDimension, CadViewSettings, Point } from "./types";
import { escapeHtml } from "./ui-utils";

interface View { minX: number; minY: number; width: number; height: number }

export function gridMarkup(view: View, unitStep: number): string {
  const desired = view.width / 36;
  const multiple = Math.max(1, Math.ceil(desired / Math.max(unitStep, 1e-6)));
  const step = Math.max(unitStep, 1e-6) * multiple;
  const lines: string[] = [];
  for (let x = Math.floor(view.minX / step) * step; x <= view.minX + view.width; x += step) lines.push(`<line x1="${x}" y1="${-view.minY - view.height}" x2="${x}" y2="${-view.minY}"/>`);
  for (let y = Math.floor(view.minY / step) * step; y <= view.minY + view.height; y += step) lines.push(`<line x1="${view.minX}" y1="${-y}" x2="${view.minX + view.width}" y2="${-y}"/>`);
  return lines.join("");
}

export function engineeringDimensions(bounds: Bounds, scale: number, owner: string, settings: CadViewSettings, lane = 0, diameter = false, position: Point = { x: 0, y: 0 }, overrides: Record<string, string> = {}, indexStart = 0): string {
  const offset = scale * (25 + lane * 8), gap = scale * 4, overshoot = scale * 5, arrow = scale * 7, arrowHalf = scale * 2.5;
  const fontSize = scale * settings.dimensionTextSize, halo = scale * Math.max(3, settings.dimensionTextSize * .32);
  const top = bounds.maxY + offset + position.y, right = bounds.maxX + offset + position.x;
  const widthText = escapeHtml(overrides[`${owner}:width`] || `${diameter ? "Ø" : ""}${bounds.width.toFixed(settings.dimensionPrecision)}${settings.dimensionUnit ? ` ${settings.dimensionUnit}` : ""}`);
  const heightText = escapeHtml(overrides[`${owner}:height`] || `${bounds.height.toFixed(settings.dimensionPrecision)}${settings.dimensionUnit ? ` ${settings.dimensionUnit}` : ""}`);
  const horizontalArrows = `<path class="cad-dimension-arrow" d="M${bounds.minX},${-top} L${bounds.minX + arrow},${-top - arrowHalf} L${bounds.minX + arrow},${-top + arrowHalf} Z M${bounds.maxX},${-top} L${bounds.maxX - arrow},${-top - arrowHalf} L${bounds.maxX - arrow},${-top + arrowHalf} Z"/>`;
  const verticalArrows = `<path class="cad-dimension-arrow" d="M${right},${-bounds.minY} L${right - arrowHalf},${-bounds.minY - arrow} L${right + arrowHalf},${-bounds.minY - arrow} Z M${right},${-bounds.maxY} L${right - arrowHalf},${-bounds.maxY + arrow} L${right + arrowHalf},${-bounds.maxY + arrow} Z"/>`;
  const selectionAttributes = (axis: "width" | "height", index: number) => `data-cad-kind="auto-dimension" data-cad-index="${index}" data-auto-dimension-owner="${escapeHtml(owner)}" data-auto-dimension-axis="${axis}"`;
  return `<g class="cad-dimensions cad-auto-dimension" data-dimension-owner="${escapeHtml(owner)}">
    <g ${selectionAttributes("width", indexStart)} data-dimension-axis="width"><line class="cad-dimension-hit" x1="${bounds.minX}" y1="${-top}" x2="${bounds.maxX}" y2="${-top}"/><line class="cad-dimension-extension" x1="${bounds.minX}" y1="${-(bounds.maxY + gap)}" x2="${bounds.minX}" y2="${-(top + overshoot)}"/><line class="cad-dimension-extension" x1="${bounds.maxX}" y1="${-(bounds.maxY + gap)}" x2="${bounds.maxX}" y2="${-(top + overshoot)}"/><line class="cad-dimension-line" x1="${bounds.minX}" y1="${-top}" x2="${bounds.maxX}" y2="${-top}"/>${horizontalArrows}<text x="${(bounds.minX + bounds.maxX) / 2}" y="${-top}" dy="${-scale * 5}" style="font-size:${fontSize}px;stroke-width:${halo}px">${widthText}</text></g>
    ${diameter ? "" : `<g ${selectionAttributes("height", indexStart + 1)} data-dimension-axis="height"><line class="cad-dimension-hit" x1="${right}" y1="${-bounds.minY}" x2="${right}" y2="${-bounds.maxY}"/><line class="cad-dimension-extension" x1="${bounds.maxX + gap}" y1="${-bounds.minY}" x2="${right + overshoot}" y2="${-bounds.minY}"/><line class="cad-dimension-extension" x1="${bounds.maxX + gap}" y1="${-bounds.maxY}" x2="${right + overshoot}" y2="${-bounds.maxY}"/><line class="cad-dimension-line" x1="${right}" y1="${-bounds.minY}" x2="${right}" y2="${-bounds.maxY}"/>${verticalArrows}<text transform="translate(${right} ${-(bounds.minY + bounds.maxY) / 2}) rotate(-90)" y="${-scale * 5}" style="font-size:${fontSize}px;stroke-width:${halo}px">${heightText}</text></g>`}
  </g>`;
}

export function linearDimensionMarkup(dimension: CadDimension, scale: number, settings: CadViewSettings, index?: number, selected = false, owner = `custom:${dimension.id}`, automaticOwner?: string, automaticIndex?: number, automaticAxis: "clearance" = "clearance"): string {
  const a = dimension.start, b = dimension.end;
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length < 1e-8) return "";
  const lineA = { x: a.x + dimension.offset.x, y: a.y + dimension.offset.y };
  const lineB = { x: b.x + dimension.offset.x, y: b.y + dimension.offset.y };
  const ux = dx / length, uy = dy / length, normal = { x: -uy, y: ux };
  const arrow = Math.min(scale * 7, length * .22), half = scale * 2.5;
  const arrowPath = (tip: Point, direction: number) => {
    const base = { x: tip.x + ux * arrow * direction, y: tip.y + uy * arrow * direction };
    return `M${tip.x},${-tip.y} L${base.x + normal.x * half},${-(base.y + normal.y * half)} L${base.x - normal.x * half},${-(base.y - normal.y * half)} Z`;
  };
  const mid = { x: (lineA.x + lineB.x) / 2 + normal.x * scale * 6, y: (lineA.y + lineB.y) / 2 + normal.y * scale * 6 };
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
  const unit = settings.dimensionUnit ? ` ${escapeHtml(settings.dimensionUnit)}` : "";
  const label = dimension.textOverride ? escapeHtml(dimension.textOverride) : `${length.toFixed(settings.dimensionPrecision)}${unit}`;
  const fontSize = scale * settings.dimensionTextSize, halo = scale * Math.max(3, settings.dimensionTextSize * .32);
  const hit = index !== undefined ? `data-cad-kind="dimension" data-cad-index="${index}" data-dimension-index="${index}"` : automaticOwner ? `data-cad-kind="auto-dimension" data-cad-index="${automaticIndex ?? 0}" data-auto-dimension-owner="${escapeHtml(automaticOwner)}" data-auto-dimension-axis="${automaticAxis}"` : "";
  return `<g class="cad-dimensions cad-linear-dimension ${selected ? "selected" : ""}" data-dimension-owner="${escapeHtml(owner)}" ${hit}><line class="cad-dimension-hit" x1="${lineA.x}" y1="${-lineA.y}" x2="${lineB.x}" y2="${-lineB.y}"/><line class="cad-dimension-extension" x1="${a.x}" y1="${-a.y}" x2="${lineA.x}" y2="${-lineA.y}"/><line class="cad-dimension-extension" x1="${b.x}" y1="${-b.y}" x2="${lineB.x}" y2="${-lineB.y}"/><line class="cad-dimension-line" x1="${lineA.x}" y1="${-lineA.y}" x2="${lineB.x}" y2="${-lineB.y}"/><path class="cad-dimension-arrow" d="${arrowPath(lineA, 1)} ${arrowPath(lineB, -1)}"/><text transform="translate(${mid.x} ${-mid.y}) rotate(${-readableAngle})" style="font-size:${fontSize}px;stroke-width:${halo}px">${label}</text></g>`;
}
