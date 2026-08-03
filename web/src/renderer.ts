import { shapePoints, transformPoint } from "./problem";
import type { AnchorName, PackingProblem, Placement, Point, SensitivityResult, Shape, ShapePart } from "./types";

const ITEM_COLORS = ["#4fc3a1", "#f4b860", "#7aa2f7", "#d98adf", "#ef6f6c", "#94c973"];
export interface LayoutDisplayOptions { dimensions?: boolean; clearance?: boolean }

export function renderLayout(canvas: HTMLCanvasElement, problem: PackingProblem, placements: Placement[] = [], display: LayoutDisplayOptions = {}): void {
  const context = setup(canvas);
  const container = polygons(shapeForContainer(problem))[0] ?? [];
  if (!container.length) return;
  const bounds = pointBounds(container);
  const padding = Math.max(bounds.width, bounds.height) * 0.08 + 1;
  const viewport = makeViewport(canvas, bounds, padding);

  context.fillStyle = "#11151b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid(context, viewport);
  drawPolygon(context, container, viewport, "#252c36", "#77808c", 2);
  if (display.clearance && problem.clearance.item_to_boundary > 0) drawDashedPolygon(context, offsetPolygon(container, -problem.clearance.item_to_boundary), viewport, "#9ba5b2");

  for (const exclusion of problem.exclusions) {
    for (const polygon of polygons(exclusion.shape)) {
      if (display.clearance) drawDashedPolygon(context, offsetPolygon(polygon, Math.max(problem.clearance.item_to_exclusion, exclusion.clearance)), viewport, "#ef6f6c");
      drawPolygon(context, polygon, viewport, "rgba(239,111,108,.26)", "#ef6f6c", 1.5);
      hatchPolygon(context, polygon, viewport);
    }
  }

  const itemIndex = new Map(problem.items.map((item, index) => [item.id, index]));
  for (const placement of placements) {
    const item = problem.items.find((entry) => entry.id === placement.item_id);
    if (!item) continue;
    const color = ITEM_COLORS[(itemIndex.get(item.id) ?? 0) % ITEM_COLORS.length];
    const placedPolygons = polygons(item.shape, placement.rotation_deg, placement.x, placement.y);
    for (const polygon of placedPolygons) {
      if (display.clearance && problem.clearance.item_to_item > 0) drawDashedPolygon(context, offsetPolygon(polygon, problem.clearance.item_to_item / 2), viewport, color);
      drawPolygon(context, polygon, viewport, `${color}b8`, placement.fixed ? "#fff4d6" : color, placement.fixed ? 2.5 : 1.1);
    }
    if (display.dimensions) drawDimensions(context, placedPolygons.flat(), viewport);
  }
}

export function renderSensitivity(canvas: HTMLCanvasElement, result: SensitivityResult | null, selectedValue: number | null = null): void {
  const availableWidth = canvas.parentElement?.clientWidth ?? 0;
  canvas.style.width = result ? `${Math.max(availableWidth, result.evaluations.length * 58 + 72)}px` : "100%";
  const context = setup(canvas);
  context.fillStyle = "#171c24";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!result || result.evaluations.length === 0) {
    context.fillStyle = "#7f8996";
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
  context.strokeStyle = "#3a424e";
  context.lineWidth = scale;
  context.beginPath(); context.moveTo(left, top); context.lineTo(left, bottom); context.lineTo(right, bottom); context.stroke();
  for (const transition of result.transitions) {
    const lower = x(transition.lower_value), upper = x(transition.upper_value);
    context.fillStyle = "rgba(244,184,96,.09)";
    context.fillRect(lower, top, Math.max(upper - lower, 2 * scale), bottom - top);
  }
  context.strokeStyle = "#4fc3a1";
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
      context.strokeStyle = "#eefaf7"; context.lineWidth = 2 * scale;
      context.beginPath(); context.arc(x(entry.value), y(entry.capacity), 7 * scale, 0, Math.PI * 2); context.stroke();
    }
    context.fillStyle = selected ? "#eefaf7" : "#f4b860";
    context.beginPath(); context.arc(x(entry.value), y(entry.capacity), 3.2 * scale, 0, Math.PI * 2); context.fill();
  }
  context.fillStyle = "#9ba5b2";
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

export function renderShapePreview(canvas: HTMLCanvasElement, shape: Shape): void {
  const context = setup(canvas);
  context.fillStyle = "#141a21";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const shapePolygons = polygons(shape);
  const points = shapePolygons.flat();
  if (!points.length) return;
  const bounds = pointBounds(points);
  const padding = Math.max(bounds.width, bounds.height) * 0.18 + 0.25;
  const viewport = makeViewport(canvas, bounds, padding);
  shapePolygons.forEach((polygon, index) => {
    const color = ITEM_COLORS[index % ITEM_COLORS.length];
    drawPolygon(context, polygon, viewport, `${color}73`, color, 1.2);
  });
  const origin = screen({ x: 0, y: 0 }, viewport);
  context.strokeStyle = "rgba(255,255,255,.25)";
  context.lineWidth = devicePixelRatio;
  context.beginPath(); context.moveTo(origin.x - 4 * devicePixelRatio, origin.y); context.lineTo(origin.x + 4 * devicePixelRatio, origin.y); context.moveTo(origin.x, origin.y - 4 * devicePixelRatio); context.lineTo(origin.x, origin.y + 4 * devicePixelRatio); context.stroke();
}

function shapeForContainer(problem: PackingProblem): Shape { return problem.container.boundary; }

function polygons(shape: Shape, rotation = 0, x = 0, y = 0): Point[][] {
  if (shape.kind === "compound") {
    const translations = resolveShapePartTranslations(shape.parts);
    return shape.parts.flatMap((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y)
      .map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y))));
  }
  return [shapePoints(shape).map((point) => transformPoint(point, rotation, x, y))];
}

function resolveShapePartTranslations(parts: ShapePart[]): Point[] {
  const resolved: Array<Point | undefined> = Array(parts.length);
  const active = new Set<number>();
  const resolve = (index: number): Point => {
    if (resolved[index]) return resolved[index]!;
    const part = parts[index];
    if (!part.snap || !parts[part.snap.target_part] || active.has(index)) return part.translation;
    active.add(index);
    const targetPosition = resolve(part.snap.target_part);
    const own = shapeAnchor(part.shape, part.rotation_deg, part.snap.own_anchor);
    const target = shapeAnchor(parts[part.snap.target_part].shape, parts[part.snap.target_part].rotation_deg, part.snap.target_anchor);
    target.x += targetPosition.x; target.y += targetPosition.y;
    const position = { x: target.x - own.x + part.snap.offset.x, y: target.y - own.y + part.snap.offset.y };
    active.delete(index); resolved[index] = position; return position;
  };
  return parts.map((_, index) => resolve(index));
}

function shapeAnchor(shape: Shape, rotation: number, anchor: AnchorName): Point {
  const local = boundsAnchor(polygonBounds(polygons(shape).flat()), anchor);
  return transformPoint(local, rotation, 0, 0);
}

function polygonBounds(points: Point[]) {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function boundsAnchor(bounds: ReturnType<typeof polygonBounds>, anchor: AnchorName): Point {
  const centerX = (bounds.minX + bounds.maxX) / 2, centerY = (bounds.minY + bounds.maxY) / 2;
  const anchors: Record<AnchorName, Point> = {
    center: { x: centerX, y: centerY }, top: { x: centerX, y: bounds.maxY }, bottom: { x: centerX, y: bounds.minY },
    left: { x: bounds.minX, y: centerY }, right: { x: bounds.maxX, y: centerY },
    top_left: { x: bounds.minX, y: bounds.maxY }, top_right: { x: bounds.maxX, y: bounds.maxY },
    bottom_left: { x: bounds.minX, y: bounds.minY }, bottom_right: { x: bounds.maxX, y: bounds.minY },
  };
  return anchors[anchor];
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

function drawPolygon(context: CanvasRenderingContext2D, points: Point[], viewport: ReturnType<typeof makeViewport>, fill: string, stroke: string, width: number): void {
  if (!points.length) return;
  context.beginPath();
  points.forEach((point, index) => { const p = screen(point, viewport); if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); });
  context.closePath(); context.fillStyle = fill; context.fill(); context.strokeStyle = stroke; context.lineWidth = width * devicePixelRatio; context.stroke();
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
  context.save(); context.strokeStyle = "rgba(238,250,247,.78)"; context.fillStyle = "#eefaf7"; context.lineWidth = devicePixelRatio; context.font = `${8 * devicePixelRatio}px DM Mono, monospace`; context.textAlign = "center";
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

function lineIntersection(a: { point: Point; direction: Point }, b: { point: Point; direction: Point }): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const delta = { x: b.point.x - a.point.x, y: b.point.y - a.point.y };
  const amount = (delta.x * b.direction.y - delta.y * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
}

function hatchPolygon(context: CanvasRenderingContext2D, points: Point[], viewport: ReturnType<typeof makeViewport>): void {
  context.save();
  context.beginPath();
  points.forEach((point, index) => { const p = screen(point, viewport); if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); });
  context.closePath(); context.clip(); context.strokeStyle = "rgba(239,111,108,.45)"; context.lineWidth = devicePixelRatio;
  for (let x = -canvasDiagonal(context.canvas); x < canvasDiagonal(context.canvas); x += 12 * devicePixelRatio) {
    context.beginPath(); context.moveTo(x, context.canvas.height); context.lineTo(x + context.canvas.height, 0); context.stroke();
  }
  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, viewport: ReturnType<typeof makeViewport>): void {
  const step = viewport.scale < 16 ? 5 : 1;
  context.strokeStyle = "rgba(255,255,255,.035)"; context.lineWidth = devicePixelRatio;
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
