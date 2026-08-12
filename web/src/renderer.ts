import { transformPoint } from "./problem";
import { resolveGeometry } from "./geometry-resolver";
import { ITEM_COLORS } from "./design-tokens";
import { contourArea, offsetPolygon } from "./polygon-utils";
import { pointBounds } from "./cad-geometry";
import type { CadDimension, CadViewSettings, PackingProblem, Placement, Point, SensitivityResult } from "./types";
export interface LayoutDisplayOptions { dimensions?: boolean; clearance?: boolean; viewSettings?: CadViewSettings; customDimensions?: CadDimension[] }

export function renderLayout(canvas: HTMLCanvasElement, problem: PackingProblem, placements: Placement[] = [], display: LayoutDisplayOptions = {}): void {
  const context = setup(canvas);
  const theme = canvasTheme();
  const settings = display.viewSettings ?? { showGrid: true, showDimensions: false, showClearance: false, dimensionTextSize: 11, edgeThickness: 1.4, dimensionPrecision: 2, dimensionUnit: "" };
  const geometry = resolveGeometry(problem), regionPolygons = geometry.container;
  context.fillStyle = theme.canvas;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!regionPolygons.length) return;
  const customPoints = display.dimensions ? (display.customDimensions ?? []).flatMap((dimension) => [dimension.start, dimension.end, { x: dimension.start.x + dimension.offset.x, y: dimension.start.y + dimension.offset.y }, { x: dimension.end.x + dimension.offset.x, y: dimension.end.y + dimension.offset.y }]) : [];
  const bounds = pointBounds([...regionPolygons.flat(), ...customPoints]);
  const padding = Math.max(bounds.width, bounds.height) * 0.08 + 1;
  const viewport = makeViewport(canvas, bounds, padding);

  if (settings.showGrid) drawGrid(context, viewport);
  drawPolygonSet(context, regionPolygons, viewport, theme.region, theme.muted, settings.edgeThickness);
  if (display.dimensions) { drawDimensions(context, regionPolygons.flat(), viewport, settings); drawClearanceDimension(context, regionPolygons.flat(), problem.clearance.item_to_boundary, false, viewport, settings); }
  if (display.clearance && problem.clearance.item_to_boundary > 0) regionPolygons.forEach((region) =>
    drawDashedPolygon(context, offsetPolygon(region, contourArea(region) >= 0 ? -problem.clearance.item_to_boundary : problem.clearance.item_to_boundary), viewport, theme.muted));

  for (const exclusion of problem.exclusions) {
    const exclusionPolygons = geometry.exclusions.find((entry) => entry.id === exclusion.id)?.polygons ?? [];
    for (const polygon of exclusionPolygons) {
      if (display.clearance) {
        const distance = Math.max(problem.clearance.item_to_exclusion, exclusion.clearance);
        drawDashedPolygon(context, offsetPolygon(polygon, contourArea(polygon) >= 0 ? distance : -distance), viewport, theme.danger);
      }
    }
    drawPolygonSet(context, exclusionPolygons, viewport, theme.dangerFill, theme.danger, 1.5);
    hatchPolygonSet(context, exclusionPolygons, viewport);
    if (display.dimensions) { drawDimensions(context, exclusionPolygons.flat(), viewport, settings, exclusion.shape.kind === "circle"); drawClearanceDimension(context, exclusionPolygons.flat(), Math.max(problem.clearance.item_to_exclusion, exclusion.clearance), true, viewport, settings); }
  }

  const itemIndex = new Map(problem.items.map((item, index) => [item.id, index]));
  const dimensionedItems = new Set<string>();
  for (const placement of placements) {
    const item = problem.items.find((entry) => entry.id === placement.item_id);
    if (!item) continue;
    const color = ITEM_COLORS[(itemIndex.get(item.id) ?? 0) % ITEM_COLORS.length];
    const local = geometry.items.find((entry) => entry.id === item.id)?.polygons ?? [];
    const placedPolygons = local.map((polygon) => polygon.map((point) => transformPoint(point, placement.rotation_deg, placement.x, placement.y)));
    for (const polygon of placedPolygons) {
      if (display.clearance && problem.clearance.item_to_item > 0) drawDashedPolygon(context, offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * problem.clearance.item_to_item / 2), viewport, color);
    }
    drawPolygonSet(context, placedPolygons, viewport, `${color}b8`, placement.fixed ? "#fff4d6" : color, placement.fixed ? settings.edgeThickness * 1.8 : settings.edgeThickness);
    if (display.dimensions && !dimensionedItems.has(item.id)) { drawDimensions(context, placedPolygons.flat(), viewport, settings, item.shape.kind === "circle"); drawClearanceDimension(context, placedPolygons.flat(), problem.clearance.item_to_item, true, viewport, settings); dimensionedItems.add(item.id); }
  }
  if (display.dimensions) (display.customDimensions ?? []).forEach((dimension) => drawLinearDimension(context, dimension, viewport, settings));
}

export function renderSensitivity(canvas: HTMLCanvasElement, result: SensitivityResult | null, selectedValue: number | null = null): void {
  const theme = canvasTheme();
  const availableWidth = canvas.parentElement?.clientWidth ?? 0;
  canvas.style.width = result ? `${Math.max(availableWidth, result.evaluations.length * 58 + 72)}px` : "100%";
  const context = setup(canvas);
  context.fillStyle = theme.surface;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!result || result.evaluations.length === 0) {
    context.fillStyle = theme.muted;
    context.font = `${14 * devicePixelRatio}px system-ui`;
    context.fillText("Run a sensitivity study to inspect capacity transitions", 20 * devicePixelRatio, 36 * devicePixelRatio);
    return;
  }
  const values = result.evaluations.map((entry) => entry.value);
  const capacities = result.evaluations.map((entry) => entry.capacity);
  const minX = Math.min(...values);
  const maxX = Math.max(...values);
  const minY = Math.min(...capacities);
  const maxY = Math.max(...capacities);
  const scale = devicePixelRatio;
  const left = 46 * scale, right = canvas.width - 18 * scale, top = 18 * scale, bottom = canvas.height - 32 * scale;
  const x = (value: number) => left + (value - minX) / Math.max(maxX - minX, 1e-9) * (right - left);
  const y = (capacity: number) => bottom - (capacity - minY) / Math.max(maxY - minY, 1) * (bottom - top);
  context.strokeStyle = theme.line;
  context.lineWidth = scale;
  context.beginPath(); context.moveTo(left, top); context.lineTo(left, bottom); context.lineTo(right, bottom); context.stroke();
  for (const transition of result.transitions) {
    const lower = x(transition.lower_value), upper = x(transition.upper_value);
    context.fillStyle = "rgba(244,184,96,.09)";
    context.fillRect(lower, top, Math.max(upper - lower, 2 * scale), bottom - top);
  }
  context.strokeStyle = theme.accent;
  context.lineWidth = 2 * scale;
  context.beginPath();
  result.evaluations.forEach((entry, index) => {
    const px = x(entry.value), py = y(entry.capacity);
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  });
  context.stroke();
  for (const entry of result.evaluations) {
    const selected = selectedValue !== null && Math.abs(entry.value - selectedValue) < 1e-9;
    if (selected) {
      context.strokeStyle = theme.text; context.lineWidth = 2 * scale;
      context.beginPath(); context.arc(x(entry.value), y(entry.capacity), 7 * scale, 0, Math.PI * 2); context.stroke();
    }
    context.fillStyle = selected ? theme.text : theme.amber;
    context.beginPath(); context.arc(x(entry.value), y(entry.capacity), 3.2 * scale, 0, Math.PI * 2); context.fill();
  }
  context.fillStyle = theme.muted;
  context.font = `${11 * scale}px system-ui`;
  context.fillText(format(minX), left, canvas.height - 10 * scale);
  context.fillText(format(maxX), right - 28 * scale, canvas.height - 10 * scale);
  context.fillText(String(maxY), 16 * scale, top + 4 * scale);
  context.fillText(String(minY), 16 * scale, bottom + 4 * scale);
}

export function sensitivityValueAt(canvas: HTMLCanvasElement, result: SensitivityResult, clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  const plotLeft = 46, plotRight = Math.max(plotLeft + 1, rect.width - 18);
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left - plotLeft) / (plotRight - plotLeft)));
  const values = result.evaluations.map((entry) => entry.value);
  const target = Math.min(...values) + ratio * (Math.max(...values) - Math.min(...values));
  return result.evaluations.reduce((best, entry) => Math.abs(entry.value - target) < Math.abs(best.value - target) ? entry : best).value;
}

export function renderPolygonsPreview(canvas: HTMLCanvasElement, shapePolygons: Point[][], options: { transparent?: boolean; dimensions?: boolean; clearance?: number } = {}): void {
  const context = setup(canvas), theme = canvasTheme();
  if (options.transparent) context.clearRect(0, 0, canvas.width, canvas.height);
  else { context.fillStyle = theme.canvas; context.fillRect(0, 0, canvas.width, canvas.height); }
  const points = shapePolygons.flat(); if (!points.length) return;
  const bounds = pointBounds(points), padding = Math.max(bounds.width, bounds.height) * .18 + .25;
  const viewport = makeViewport(canvas, bounds, padding);
  if (options.clearance && options.clearance > 0) shapePolygons.forEach((polygon) => drawDashedPolygon(context, offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * options.clearance!), viewport, ITEM_COLORS[0]));
  drawPolygonSet(context, shapePolygons, viewport, `${ITEM_COLORS[0]}73`, ITEM_COLORS[0], 1.2);
  if (options.dimensions) drawDimensions(context, points, viewport, { showGrid: true, showDimensions: false, showClearance: false, dimensionTextSize: 11, edgeThickness: 1.4, dimensionPrecision: 2, dimensionUnit: "" });
}

function setup(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  return canvas.getContext("2d")!;
}

function makeViewport(canvas: HTMLCanvasElement, bounds: ReturnType<typeof pointBounds>, padding: number) {
  const worldWidth = bounds.width + padding * 2, worldHeight = bounds.height + padding * 2;
  const scale = Math.min(canvas.width / worldWidth, canvas.height / worldHeight);
  const offsetX = (canvas.width - bounds.width * scale) / 2 - bounds.minX * scale;
  const offsetY = (canvas.height - bounds.height * scale) / 2 + bounds.maxY * scale;
  return { scale, offsetX, offsetY, world: bounds };
}

function screen(point: Point, viewport: ReturnType<typeof makeViewport>): Point {
  return { x: viewport.offsetX + point.x * viewport.scale, y: viewport.offsetY - point.y * viewport.scale };
}

function drawPolygonSet(context: CanvasRenderingContext2D, polygons: Point[][], viewport: ReturnType<typeof makeViewport>, fill: string, stroke: string, width: number): void {
  if (!polygons.length) return;
  context.beginPath();
  polygons.forEach((points) => {
    points.forEach((point, index) => { const p = screen(point, viewport); if (!index) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); });
    context.closePath();
  });
  context.fillStyle = fill; context.fill("evenodd"); context.strokeStyle = stroke; context.lineWidth = width * devicePixelRatio; context.stroke();
}

function drawDashedPolygon(context: CanvasRenderingContext2D, points: Point[], viewport: ReturnType<typeof makeViewport>, color: string): void {
  if (!points.length) return;
  context.save(); context.setLineDash([5 * devicePixelRatio, 4 * devicePixelRatio]);
  context.beginPath(); points.forEach((point, index) => { const value = screen(point, viewport); if (index) context.lineTo(value.x, value.y); else context.moveTo(value.x, value.y); });
  context.closePath(); context.strokeStyle = color; context.globalAlpha = .72; context.lineWidth = 1.2 * devicePixelRatio; context.stroke(); context.restore();
}

function drawDimensions(context: CanvasRenderingContext2D, points: Point[], viewport: ReturnType<typeof makeViewport>, settings: CadViewSettings, diameter = false): void {
  if (!points.length) return;
  const bounds = pointBounds(points), topLeft = screen({ x: bounds.minX, y: bounds.maxY }, viewport), bottomRight = screen({ x: bounds.maxX, y: bounds.minY }, viewport);
  const offset = 8 * devicePixelRatio;
  const theme = canvasTheme();
  const unit = settings.dimensionUnit ? ` ${settings.dimensionUnit}` : "";
  context.save(); context.strokeStyle = theme.text; context.fillStyle = theme.text; context.globalAlpha = .9; context.lineWidth = Math.max(devicePixelRatio, settings.edgeThickness * .75 * devicePixelRatio); context.font = `650 ${settings.dimensionTextSize * devicePixelRatio}px ui-monospace, monospace`; context.textAlign = "center";
  context.beginPath(); context.moveTo(topLeft.x, topLeft.y - offset); context.lineTo(bottomRight.x, topLeft.y - offset); context.moveTo(topLeft.x, topLeft.y - offset * 1.35); context.lineTo(topLeft.x, topLeft.y - offset * .65); context.moveTo(bottomRight.x, topLeft.y - offset * 1.35); context.lineTo(bottomRight.x, topLeft.y - offset * .65); context.stroke();
  context.fillText(`${diameter ? "Ø" : ""}${bounds.width.toFixed(settings.dimensionPrecision)}${unit}`, (topLeft.x + bottomRight.x) / 2, topLeft.y - offset - 3 * devicePixelRatio);
  if (diameter) { context.restore(); return; }
  context.beginPath(); context.moveTo(bottomRight.x + offset, topLeft.y); context.lineTo(bottomRight.x + offset, bottomRight.y); context.moveTo(bottomRight.x + offset * .65, topLeft.y); context.lineTo(bottomRight.x + offset * 1.35, topLeft.y); context.moveTo(bottomRight.x + offset * .65, bottomRight.y); context.lineTo(bottomRight.x + offset * 1.35, bottomRight.y); context.stroke();
  context.save(); context.translate(bottomRight.x + offset + settings.dimensionTextSize * devicePixelRatio, (topLeft.y + bottomRight.y) / 2); context.rotate(-Math.PI / 2); context.fillText(`${bounds.height.toFixed(settings.dimensionPrecision)}${unit}`, 0, 0); context.restore(); context.restore();
}

function drawClearanceDimension(context: CanvasRenderingContext2D, points: Point[], distance: number, outward: boolean, viewport: ReturnType<typeof makeViewport>, settings: CadViewSettings): void {
  if (!points.length || distance <= 0) return;
  const bounds = pointBounds(points), y = (bounds.minY + bounds.maxY) / 2;
  const start = { x: outward ? bounds.maxX : bounds.minX, y }, end = { x: outward ? bounds.maxX + distance : bounds.minX + distance, y };
  const a = screen(start, viewport), b = screen(end, viewport), theme = canvasTheme(), unit = settings.dimensionUnit ? ` ${settings.dimensionUnit}` : "";
  context.save(); context.strokeStyle = theme.text; context.fillStyle = theme.text; context.lineWidth = Math.max(devicePixelRatio, settings.edgeThickness * .75 * devicePixelRatio); context.font = `650 ${settings.dimensionTextSize * devicePixelRatio}px ui-monospace, monospace`; context.textAlign = "center";
  context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  context.fillText(`${distance.toFixed(settings.dimensionPrecision)}${unit} clear`, (a.x + b.x) / 2, a.y - 5 * devicePixelRatio); context.restore();
}

function drawLinearDimension(context: CanvasRenderingContext2D, dimension: CadDimension, viewport: ReturnType<typeof makeViewport>, settings: CadViewSettings): void {
  const start = screen(dimension.start, viewport), end = screen(dimension.end, viewport);
  const lineStart = screen({ x: dimension.start.x + dimension.offset.x, y: dimension.start.y + dimension.offset.y }, viewport);
  const lineEnd = screen({ x: dimension.end.x + dimension.offset.x, y: dimension.end.y + dimension.offset.y }, viewport);
  const length = Math.hypot(dimension.end.x - dimension.start.x, dimension.end.y - dimension.start.y); if (length < 1e-8) return;
  const angle = Math.atan2(lineEnd.y - lineStart.y, lineEnd.x - lineStart.x), normal = { x: -Math.sin(angle), y: Math.cos(angle) };
  const midpoint = { x: (lineStart.x + lineEnd.x) / 2 + normal.x * 6 * devicePixelRatio, y: (lineStart.y + lineEnd.y) / 2 + normal.y * 6 * devicePixelRatio };
  const theme = canvasTheme(), unit = settings.dimensionUnit ? ` ${settings.dimensionUnit}` : "", label = dimension.textOverride || `${length.toFixed(settings.dimensionPrecision)}${unit}`;
  context.save(); context.strokeStyle = theme.text; context.fillStyle = theme.text; context.lineWidth = Math.max(devicePixelRatio, settings.edgeThickness * .75 * devicePixelRatio); context.font = `650 ${settings.dimensionTextSize * devicePixelRatio}px ui-monospace, monospace`; context.textAlign = "center";
  context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(lineStart.x, lineStart.y); context.moveTo(end.x, end.y); context.lineTo(lineEnd.x, lineEnd.y); context.moveTo(lineStart.x, lineStart.y); context.lineTo(lineEnd.x, lineEnd.y); context.stroke();
  context.save(); context.translate(midpoint.x, midpoint.y); const readable = angle > Math.PI / 2 || angle < -Math.PI / 2 ? angle + Math.PI : angle; context.rotate(readable); context.fillText(label, 0, 0); context.restore(); context.restore();
}

function hatchPolygonSet(context: CanvasRenderingContext2D, polygons: Point[][], viewport: ReturnType<typeof makeViewport>): void {
  if (!polygons.length) return;
  context.save(); context.beginPath();
  polygons.forEach((points) => { points.forEach((point, index) => { const p = screen(point, viewport); if (!index) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); }); context.closePath(); });
  context.clip("evenodd"); context.strokeStyle = "rgba(239,111,108,.45)"; context.lineWidth = devicePixelRatio;
  for (let x = -canvasDiagonal(context.canvas); x < canvasDiagonal(context.canvas); x += 12 * devicePixelRatio) { context.beginPath(); context.moveTo(x, context.canvas.height); context.lineTo(x + context.canvas.height, 0); context.stroke(); }
  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, viewport: ReturnType<typeof makeViewport>): void {
  const step = viewport.scale < 16 ? 5 : 1;
  context.strokeStyle = canvasTheme().grid; context.lineWidth = devicePixelRatio;
  for (let x = Math.floor(viewport.world.minX / step) * step; x <= viewport.world.maxX; x += step) {
    const a = screen({ x, y: viewport.world.minY }, viewport), b = screen({ x, y: viewport.world.maxY }, viewport);
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  }
  for (let y = Math.floor(viewport.world.minY / step) * step; y <= viewport.world.maxY; y += step) {
    const a = screen({ x: viewport.world.minX, y }, viewport), b = screen({ x: viewport.world.maxX, y }, viewport);
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  }
}

function canvasDiagonal(canvas: HTMLCanvasElement): number { return Math.hypot(canvas.width, canvas.height); }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2); }

function canvasTheme() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    canvas: value("--canvas", "#10161d"), surface: value("--surface", "#151b23"),
    region: value("--surface-soft", "#202a35"), text: value("--text", "#e8edf3"),
    muted: value("--muted", "#8793a2"), line: value("--line", "#2b3541"),
    accent: value("--accent", "#51c6a4"), amber: value("--amber", "#f2b65d"),
    danger: value("--danger", "#ee716f"), dangerFill: value("--danger-soft", "rgba(238,113,111,.09)"),
    grid: document.documentElement.dataset.theme === "light" ? "rgba(25,35,45,.055)" : "rgba(255,255,255,.04)",
  };
}
