export interface Point { x: number; y: number }
export interface BezierKnot { point: Point; control_in: Point; control_out: Point }

export type Shape =
  | { kind: "polygon"; vertices: Point[] }
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number }
  | { kind: "circle"; radius: number; segments: number }
  | { kind: "bezier"; knots: BezierKnot[]; segments_per_curve: number }
  | { kind: "compound"; parts: ShapePart[] };

export interface ShapePart {
  shape: Shape;
  translation: Point;
  rotation_deg: number;
  snap?: PartSnap | null;
}

export type AnchorName = "center" | "top" | "bottom" | "left" | "right" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
export interface PartSnap { target_part: number; own_anchor: AnchorName; target_anchor: AnchorName; offset: Point }

export interface PackingProblem {
  container: { boundary: Shape };
  exclusions: Array<{ id: string; shape: Shape; clearance: number }>;
  items: Array<{ id: string; shape: Shape; quantity: number; rotations: number[] }>;
  fixed_placements: Array<{ item_id: string; x: number; y: number; rotation_deg: number }>;
  clearance: { item_to_item: number; item_to_boundary: number; item_to_exclusion: number };
}

export interface SolveOptions {
  seed: number;
  deterministic: boolean;
  max_iterations: number;
  time_limit_ms: number | null;
  grid_step: number;
  restarts: number;
}

export interface Placement {
  item_id: string;
  x: number;
  y: number;
  rotation_deg: number;
  fixed: boolean;
}

export interface SolveProgress {
  iterations: number;
  packed_item_count: number;
  placements: Placement[];
  solver_strategy: string;
}

export interface SolveResult {
  layout_id: string;
  status: string;
  placements: Placement[];
  packed_item_count: number;
  packed_count_by_item: Record<string, number>;
  objective_score: number;
  simple_upper_bound: number | null;
  seed: number;
  solver_strategy: string;
  statistics: {
    candidates_evaluated: number;
    valid_candidates: number;
    iterations: number;
    elapsed_ms: number;
  };
  validation: { valid: boolean; errors: string[] };
  warnings: string[];
}

export type ParameterPath =
  | { kind: "item_width"; item_id: string }
  | { kind: "item_height"; item_id: string }
  | { kind: "item_scale"; item_id: string }
  | { kind: "item_part_width"; item_id: string; part_index: number }
  | { kind: "item_part_height"; item_id: string; part_index: number }
  | { kind: "item_part_radius"; item_id: string; part_index: number }
  | { kind: "item_part_scale"; item_id: string; part_index: number }
  | { kind: "clearance_item_to_item" }
  | { kind: "clearance_item_to_boundary" }
  | { kind: "container_width" }
  | { kind: "container_height" }
  | { kind: "exclusion_scale"; exclusion_id: string };

export interface SensitivityStudy {
  parameter: ParameterPath;
  start: number;
  end: number;
  initial_step: number;
  transition_tolerance: number;
  strategy: "sampled" | "adaptive";
  solve_options: SolveOptions;
  seed_policy: "fixed" | "derive_from_value";
  increasing_is_harder: boolean;
}

export interface SensitivityProgress {
  completed: number;
  initial_total: number;
  value: number;
  capacity: number;
  phase: "sampling" | "refining";
}

export interface SensitivityResult {
  evaluations: Array<{ value: number; capacity: number; status: string; problem: PackingProblem; result: SolveResult }>;
  representative_layouts: Record<string, SolveResult>;
  transitions: Array<{
    lower_value: number;
    upper_value: number;
    lower_capacity: number;
    upper_capacity: number;
  }>;
  warnings: string[];
}

export interface EditorSnap { targetId: string; ownAnchor: AnchorName; targetAnchor: AnchorName; offset: Point }
interface PrimitiveBase { id: string; x: number; y: number; rotation: number; snap?: EditorSnap }
export type PrimitiveEditor = PrimitiveBase & (
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number }
  | { kind: "circle"; radius: number; segments: number }
  | { kind: "polygon"; vertices: Point[] }
  | { kind: "bezier"; knots: BezierKnot[]; segments: number }
);

export interface EditorItem {
  id: string;
  quantity: number;
  rotations: string;
  parts: PrimitiveEditor[];
}

export interface EditorExclusion {
  id: string;
  clearance: number;
  primitive: PrimitiveEditor;
}

export interface EditorState {
  container: PrimitiveEditor;
  items: EditorItem[];
  exclusions: EditorExclusion[];
  fixedPlacements: PackingProblem["fixed_placements"];
  clearance: PackingProblem["clearance"];
  options: SolveOptions;
  study: Omit<SensitivityStudy, "parameter" | "solve_options"> & { parameterKey: string };
}
