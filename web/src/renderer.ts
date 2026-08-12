import { transformPoint } from "./problem";
import { resolveGeometry } from "./geometry-resolver";
import type { PackingProblem, Placement, Point, SensitivityResult } from "./types";

const ITEM_COLORS = ["#4fc3a1", "#f4b860", "#7aa2f7", "#d98adf", "#ef6f6c", "#94c973"];
export interface LayoutDisplayOptions { dimensions?: boolean; clearance?: boolean }

export function renderLayout(canvas: HTMLCanvasElement, problem: PackingProblem, placements: Placement[] = [], display: LayoutDisplayOptions = {}): void {
  const context = setup(canvas);
  const theme = canvasTheme();
  const geometry = resolveGeometry(problem), regionPolygons = geometry.container;
  context.fillStyle = theme.canvas;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!regionPolygons.length) return;
  const bounds = pointBounds(regionPolygons.flat());
  const padding = Math.max(bounds.width, bounds.height) * 0.08 + 1;
  const viewport = makeViewport(canvas, bounds, padding);

  drawGrid(context, viewport);
  drawPolygonSet(context, regionPolygons, viewport, theme.region, theme.muted, 2);
  if (display.dimensions) drawDimensions(context, regionPolygons.flat(), viewport);
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
    if (display.dimensions) drawDimensions(context, exclusionPolygons.flat(), viewport);
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
    drawPolygonSet(context, placedPolygons, viewport, `${color}b8`, placement.fixed ? "#fff4d6" : color, placement.fixed ? 2.5 : 1.1);
    if (display.dimensions && !dimensionedItems.has(item.id)) { drawDimensions(context, placedPolygons.flat(), viewport); dimensionedItems.add(item.id); }
  }
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
  if (options.dimensions) drawDimensions(context, points, viewport);
}

function setup(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  return canvas.getContext("2d")!;
}

function pointBounds(points: Point[]) {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
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

function drawDimensions(context: CanvasRenderingContext2D, points: Point[], viewport: ReturnType<typeof makeViewport>): void {
  if (!points.length) return;
  const bounds = pointBounds(points), topLeft = screen({ x: bounds.minX, y: bounds.maxY }, viewport), bottomRight = screen({ x: bounds.maxX, y: bounds.minY }, viewport);
  const offset = 8 * devicePixelRatio;
  const theme = canvasTheme();
  context.save(); context.strokeStyle = theme.text; context.fillStyle = theme.text; context.globalAlpha = .82; context.lineWidth = devicePixelRatio; context.font = `${8 * devicePixelRatio}px ui-monospace, monospace`; context.textAlign = "center";
  context.beginPath(); context.moveTo(topLeft.x, topLeft.y - offset); context.lineTo(bottomRight.x, topLeft.y - offset); context.moveTo(topLeft.x, topLeft.y - offset * 1.35); context.lineTo(topLeft.x, topLeft.y - offset * .65); context.moveTo(bottomRight.x, topLeft.y - offset * 1.35); context.lineTo(bottomRight.x, topLeft.y - offset * .65); context.stroke();
  context.fillText(format(bounds.width), (topLeft.x + bottomRight.x) / 2, topLeft.y - offset - 3 * devicePixelRatio);
  context.beginPath(); context.moveTo(bottomRight.x + offset, topLeft.y); context.lineTo(bottomRight.x + offset, bottomRight.y); context.moveTo(bottomRight.x + offset * .65, topLeft.y); context.lineTo(bottomRight.x + offset * 1.35, topLeft.y); context.moveTo(bottomRight.x + offset * .65, bottomRight.y); context.lineTo(bottomRight.x + offset * 1.35, bottomRight.y); context.stroke();
  context.save(); context.translate(bottomRight.x + offset + 9 * devicePixelRatio, (topLeft.y + bottomRight.y) / 2); context.rotate(-Math.PI / 2); context.fillText(format(bounds.height), 0, 0); context.restore(); context.restore();
}

function offsetPolygon(points: Point[], distance: number): Point[] {
  if (points.length < 3 || distance === 0) return points;
  const area = points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
  const direction = area >= 0 ? 1 : -1;
  const shifted = points.map((point, index) => {
    const next = points[(index + 1) % points.length], dx = next.x - point.x, dy = next.y - point.y, length = Math.hypot(dx, dy) || 1;
    const normal = { x: direction * dy / length * distance, y: -direction * dx / length * distance };
    return { point: { x: point.x + normal.x, y: point.y + normal.y }, direction: { x: dx, y: dy } };
  });
  return points.map((_, index) => lineIntersection(shifted[(index + shifted.length - 1) % shifted.length], shifted[index]) ?? shifted[index].point);
}

function contourArea(points: Point[]): number {
  return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
}

function lineIntersection(a: { point: Point; direction: Point }, b: { point: Point; direction: Point }): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const delta = { x: b.point.x - a.point.x, y: b.point.y - a.point.y };
  const amount = (delta.x * b.direction.y - delta.y * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
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
