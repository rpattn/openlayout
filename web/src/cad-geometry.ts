import { shapePoints, transformPoint } from "./problem";
import type { AnchorName, Point, Shape, ShapePart } from "./types";

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }

export function rotateVector(point: Point, rotation: number): Point {
  const radians = rotation * Math.PI / 180;
  return { x: round(point.x * Math.cos(radians) - point.y * Math.sin(radians)), y: round(point.x * Math.sin(radians) + point.y * Math.cos(radians)) };
}

export function rotateAround(point: Point, center: Point, rotation: number): Point {
  const delta = rotateVector({ x: point.x - center.x, y: point.y - center.y }, rotation);
  return { x: center.x + delta.x, y: center.y + delta.y };
}

export function polygons(shape: Shape, rotation = 0, x = 0, y = 0): Point[][] {
  if (shape.kind === "compound") {
    const translations = resolveShapePartTranslations(shape.parts);
    return shape.parts.flatMap((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y)
      .map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y))));
  }
  return [shapePoints(shape).map((point) => transformPoint(point, rotation, x, y))];
}

export function sourcePartPolygons(shape: Shape): Point[][][] {
  if (shape.kind !== "compound") return [polygons(shape)];
  const translations = resolveShapePartTranslations(shape.parts);
  return shape.parts.map((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y));
}

export function transformPolygons(input: Point[][], rotation: number, x: number, y: number): Point[][] {
  return input.map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y)));
}

export function inverseTransformPoint(point: Point, rotation: number, x: number, y: number): Point {
  const radians = -rotation * Math.PI / 180;
  const dx = point.x - x, dy = point.y - y;
  return { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) };
}

export function resolveShapePartTranslations(parts: ShapePart[]): Point[] {
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
    const position = { x: targetPosition.x + target.x - own.x + part.snap.offset.x, y: targetPosition.y + target.y - own.y + part.snap.offset.y };
    active.delete(index);
    resolved[index] = position;
    return position;
  };
  return parts.map((_, index) => resolve(index));
}

export function pointBounds(points: Point[]): Bounds {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function path(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${round(point.x, 4)},${round(-point.y, 4)}`).join(" ") + " Z";
}

export function compoundPath(input: Point[][]): string {
  return input.map(path).join(" ");
}

export function pointInCompound(point: Point, input: Point[][]): boolean {
  return input.reduce((inside, polygon) => inside !== pointInPolygon(point, polygon), false);
}

export function compoundsOverlap(a: Point[][], b: Point[][]): boolean {
  return a.some((left) => b.some((right) => polygonsOverlap(left, right)));
}

export function compoundDistance(a: Point[][], b: Point[][]): number {
  if (!a.length || !b.length) return Infinity;
  return Math.min(...a.flatMap((left) => b.map((right) => polygonDistance(left, right))));
}

export function compoundEdgeDistance(a: Point[][], b: Point[][]): number {
  if (!a.length || !b.length) return Infinity;
  return Math.min(...a.flatMap((left) => b.map((right) => polygonEdgeDistance(left, right))));
}

function shapeAnchor(shape: Shape, rotation: number, anchor: AnchorName): Point {
  const bounds = pointBounds(polygons(shape).flat());
  const x = anchor.includes("left") ? bounds.minX : anchor.includes("right") ? bounds.maxX : (bounds.minX + bounds.maxX) / 2;
  const y = anchor.includes("bottom") ? bounds.minY : anchor.includes("top") ? bounds.maxY : (bounds.minY + bounds.maxY) / 2;
  return transformPoint({ x, y }, rotation, 0, 0);
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true;
  return edges(a).some(([a1, a2]) => edges(b).some(([b1, b2]) => segmentsIntersect(a1, a2, b1, b2)));
}

function polygonEdgeDistance(a: Point[], b: Point[]): number {
  return Math.min(...edges(a).flatMap(([a1, a2]) => edges(b).map(([b1, b2]) => Math.min(pointSegmentDistance(a1, b1, b2), pointSegmentDistance(a2, b1, b2), pointSegmentDistance(b1, a1, a2), pointSegmentDistance(b2, a1, a2)))));
}

function polygonDistance(a: Point[], b: Point[]): number {
  if (polygonsOverlap(a, b)) return 0;
  return polygonEdgeDistance(a, b);
}

function edges(polygon: Point[]): Array<[Point, Point]> {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  if (!length) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
