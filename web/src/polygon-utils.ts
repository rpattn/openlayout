import type { Point } from "./types";

interface DirectedLine { point: Point; direction: Point }

export function contourArea(points: Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
}

export function offsetPolygon(points: Point[], distance: number): Point[] {
  if (points.length < 3 || distance === 0) return points;
  const direction = contourArea(points) >= 0 ? 1 : -1;
  const shifted = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy) || 1;
    return {
      point: {
        x: point.x + direction * dy / length * distance,
        y: point.y - direction * dx / length * distance,
      },
      direction: { x: dx, y: dy },
    };
  });
  return points.map((_, index) => lineIntersection(
    shifted[(index + shifted.length - 1) % shifted.length],
    shifted[index],
  ) ?? shifted[index].point);
}

/** SVG path for a closed polygon with short quadratic arcs at sharp joins. */
export function roundedPolygonPath(points: Point[], radius: number): string {
  if (points.length < 3 || radius <= 0) return points.map((point, index) => `${index ? "L" : "M"}${rounded(point.x)},${rounded(-point.y)}`).join(" ") + " Z";
  const corners = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length], next = points[(index + 1) % points.length];
    const previousLength = Math.hypot(previous.x - point.x, previous.y - point.y);
    const nextLength = Math.hypot(next.x - point.x, next.y - point.y);
    const cut = Math.min(radius, previousLength * .28, nextLength * .28);
    const toward = (target: Point, length: number): Point => length > 1e-9
      ? { x: point.x + (target.x - point.x) * cut / length, y: point.y + (target.y - point.y) * cut / length }
      : point;
    return { point, start: toward(previous, previousLength), end: toward(next, nextLength) };
  });
  return corners.map((corner, index) => `${index ? "L" : "M"}${rounded(corner.start.x)},${rounded(-corner.start.y)} Q${rounded(corner.point.x)},${rounded(-corner.point.y)} ${rounded(corner.end.x)},${rounded(-corner.end.y)}`).join(" ") + " Z";
}

function rounded(value: number): number { return Math.round(value * 10_000) / 10_000; }

function lineIntersection(a: DirectedLine, b: DirectedLine): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const amount = (dx * b.direction.y - dy * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
}
