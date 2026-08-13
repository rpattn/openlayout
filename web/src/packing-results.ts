import { resolveGeometry } from "./geometry-resolver";
import { contourArea } from "./polygon-utils";
import type { PackingProblem, SolveResult } from "./types";

export interface PackingItemOutcome {
  id: string;
  requested: number;
  packed: number;
  unplaced: number;
}

export interface PackingOutcome {
  requested: number;
  packed: number;
  unplaced: number;
  completion: number;
  utilisation: number;
  items: PackingItemOutcome[];
}

export function packingOutcome(problem: PackingProblem, result: SolveResult): PackingOutcome {
  const geometry = resolveGeometry(problem);
  const requested = problem.items.reduce((sum, item) => sum + Math.max(0, item.quantity), 0);
  const packed = result.placements.length;
  const itemAreas = new Map(geometry.items.map((item) => [item.id, compoundArea(item.polygons)]));
  const packedArea = result.placements.reduce((sum, placement) => sum + (itemAreas.get(placement.item_id) ?? 0), 0);
  const containerArea = compoundArea(geometry.container);
  return {
    requested,
    packed,
    unplaced: Math.max(0, requested - packed),
    completion: requested ? Math.round(packed / requested * 100) : 100,
    utilisation: containerArea ? Math.round(packedArea / containerArea * 1000) / 10 : 0,
    items: problem.items.map((item) => {
      const itemPacked = result.packed_count_by_item[item.id] ?? 0;
      return { id: item.id, requested: item.quantity, packed: itemPacked, unplaced: Math.max(0, item.quantity - itemPacked) };
    }),
  };
}

function compoundArea(polygons: Array<Array<{ x: number; y: number }>>): number {
  return Math.abs(polygons.reduce((sum, polygon) => sum + contourArea(polygon), 0)) / 2;
}
