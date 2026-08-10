import init, { resolved_geometry } from "./wasm/packing_wasm.js";
import type { PackingProblem, ResolvedProblemGeometry } from "./types";

let initialized = false;

export async function initGeometryResolver(): Promise<void> {
  if (!initialized) {
    await init();
    initialized = true;
  }
}

export function resolveGeometry(problem: PackingProblem): ResolvedProblemGeometry {
  if (!initialized) throw new Error("Geometry engine has not been initialized");
  return JSON.parse(resolved_geometry(JSON.stringify(problem))) as ResolvedProblemGeometry;
}
