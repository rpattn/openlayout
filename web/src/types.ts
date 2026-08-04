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
  schema_version: 2;
  container: { parts: RegionPart[] };
  exclusions: Array<{ id: string; shape: Shape; clearance: number }>;
  items: Array<{ id: string; shape: Shape; quantity: number; rotation_policy: RotationPolicy }>;
  fixed_placements: Array<{ item_id: string; x: number; y: number; rotation_deg: number }>;
  clearance: { item_to_item: number; item_to_boundary: number; item_to_exclusion: number };
}

export type RegionOperation = "add" | "subtract";
export interface RegionPart { id: string; operation: RegionOperation; shape: Shape; translation: Point; rotation_deg: number }
export type RotationCoupling = "independent" | "shared_per_item";
export type RotationPolicy =
  | { kind: "discrete"; angles_deg: number[]; coupling: RotationCoupling }
  | { kind: "continuous"; min_deg: number; max_deg: number; coupling: RotationCoupling };

export interface SolveOptions {
  seed: number;
  deterministic: boolean;
  max_iterations: number;
  time_limit_ms: number | null;
  grid_step: number;
  restarts: number;
  quality: "fast" | "balanced" | "thorough";
}

export interface Placement {
  item_id: string;
  x: number;
  y: number;
  rotation_deg: number;
  fixed: boolean;
}

export interface SolveProgress {
  phase: "baseline" | "coarse_rotation" | "angle_refinement" | "neighbourhood_improvement";
  completed_fraction: number;
  max_iterations: number;
  iterations: number;
  packed_item_count: number;
  placements: Placement[];
  solver_strategy: string;
  selected_shared_angles: Record<string, number>;
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
  | { kind: "item_quantity"; item_id: string }
  | { kind: "container_part_width"; part_id: string }
  | { kind: "container_part_height"; part_id: string }
  | { kind: "container_part_scale"; part_id: string }
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
  rotationMode: "continuous" | "discrete";
  rotationCoupling: RotationCoupling;
  rotations: string;
  minRotation: number;
  maxRotation: number;
  parts: PrimitiveEditor[];
}

export interface EditorExclusion {
  id: string;
  clearance: number;
  primitive: PrimitiveEditor;
}

export interface EditorRegion {
  id: string;
  operation: RegionOperation;
  primitive: PrimitiveEditor;
}

export interface EditorState {
  containerParts: EditorRegion[];
  items: EditorItem[];
  exclusions: EditorExclusion[];
  fixedPlacements: PackingProblem["fixed_placements"];
  clearance: PackingProblem["clearance"];
  options: SolveOptions;
  study: Omit<SensitivityStudy, "parameter" | "solve_options"> & { parameterKey: string };
}
