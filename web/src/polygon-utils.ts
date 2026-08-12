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

function lineIntersection(a: DirectedLine, b: DirectedLine): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const amount = (dx * b.direction.y - dy * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
}
