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
export interface RegionPart { id: string; operation: RegionOperation; shape: Shape; translation: Point; rotation_deg: number; snap?: PartSnap | null }
export interface NamedResolvedGeometry { id: string; polygons: Point[][] }
export interface ResolvedProblemGeometry { container: Point[][]; items: NamedResolvedGeometry[]; exclusions: NamedResolvedGeometry[] }
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
  baseline_only: boolean;
  beam_width?: number | null;
  max_candidates_per_state?: number | null;
  max_search_states?: number | null;
  candidate_generation_density?: number | null;
}

export interface Placement {
  item_id: string;
  x: number;
  y: number;
  rotation_deg: number;
  fixed: boolean;
}

export interface SolveProgress {
  phase: "preparing_geometry" | "generating_candidates" | "baseline" | "beam_search" | "coarse_rotation" | "angle_refinement" | "neighbourhood_improvement" | "overlap_repair" | "clearance_continuation" | "conflict_graph" | "validating";
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
    preparation_ms: number;
    candidate_generation_ms: number;
    containment_check_ms: number;
    collision_check_ms: number;
    candidate_scoring_ms: number;
    subdivision_ms: number;
    generated_candidates: number;
    broad_phase_rejections: number;
    exact_geometry_checks: number;
    accepted_placements: number;
    explored_search_states: number;
    deduplicated_search_states: number;
    pruned_search_states: number;
    area_bound_prunes: number;
    region_bound_prunes: number;
    projection_bound_prunes: number;
    greedy_lower_bound: number;
    final_upper_bound: number | null;
    bound_gap: number | null;
    local_improvement_attempts: number;
    local_improvements_accepted: number;
    overlap_repair_attempts: number;
    overlap_repair_evaluated_moves: number;
    overlap_repair_accepted_moves: number;
    overlap_repair_weight_updates: number;
    overlap_repair_successes: number;
    overlap_repair_component_reinsert_attempts: number;
    overlap_repair_component_reinsert_successes: number;
    overlap_repair_best_penalty: number | null;
    continuation_stages: number;
    continuation_repair_only_stages: number;
    continuation_search_stages: number;
    continuation_full_solve_stages: number;
    conflict_graph_candidates: number;
    conflict_graph_status: "not_run" | "best_found" | "candidate_set_optimal" | "limit_reached";
  };
  strategies_used: string[];
  warm_start_status: "from_empty" | "retained" | "partially_repaired" | "restarted";
  validation: { valid: boolean; errors: string[] };
  warnings: string[];
  runtime_timing?: {
    total_ms: number;
    phase_ms: Partial<Record<SolveProgress["phase"], number>>;
    worker_count: number;
    lane?: "full" | "direct" | "clearance_continuation";
    cold_start_ms?: number;
    callback_count?: number;
    callback_bytes?: number;
    request_bytes?: number;
    wasm_memory_bytes?: number;
    winning_lane?: "full" | "direct" | "clearance_continuation";
    lanes?: Array<{
      lane: "full" | "direct" | "clearance_continuation";
      total_ms: number;
      cold_start_ms: number;
      callback_count: number;
      callback_bytes: number;
      request_bytes: number;
      wasm_memory_bytes: number;
    }>;
    portfolio_wins?: Partial<Record<"full" | "direct" | "clearance_continuation", number>>;
    portfolio_runs?: number;
  };
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
interface PrimitiveBase { id: string; x: number; y: number; rotation: number; color?: string; snap?: EditorSnap }
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
  parts: PrimitiveEditor[];
}

export interface EditorRegion {
  id: string;
  operation: RegionOperation;
  primitive: PrimitiveEditor;
}

export interface ConstructionGuide { id: string; x: number; y: number; rotation: number }
export interface DraftingPath { id: string; points: Point[]; x: number; y: number; rotation: number; closed: boolean }
export interface TraceImage {
  id: string;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  visible: boolean;
}
export interface DraftingText {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  rotation: number;
  color: string;
  fontFamily: "mono" | "sans" | "serif";
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
  underline: boolean;
}
export interface DraftingSettings {
  gridStep: number;
  snapToGrid: boolean;
  smartSnap: boolean;
  defaultOwner: "item" | "material" | "cutout" | "exclusion";
  guides: ConstructionGuide[];
  traceImages: TraceImage[];
  texts: DraftingText[];
  shapes: DraftingPath[];
}

export type LockableEntityKind = "container" | "exclusion" | "item" | "guide" | "drafting" | "trace" | "text";
export interface LockedEntity { kind: LockableEntityKind; id: string }
export interface CadViewSettings {
  showGrid: boolean;
  showDimensions: boolean;
  showClearance: boolean;
  dimensionTextSize: number;
  edgeThickness: number;
  dimensionPrecision: number;
  dimensionUnit: string;
}

export interface CadDimension {
  id: string;
  start: Point;
  end: Point;
  offset: Point;
  textOverride: string;
}

export interface EditorState {
  containerParts: EditorRegion[];
  items: EditorItem[];
  exclusions: EditorExclusion[];
  fixedPlacements: PackingProblem["fixed_placements"];
  clearance: PackingProblem["clearance"];
  options: SolveOptions;
  drafting: DraftingSettings;
  lockedEntities: LockedEntity[];
  viewSettings: CadViewSettings;
  dimensions: CadDimension[];
  dimensionPositions: Record<string, Point>;
  dimensionOverrides: Record<string, string>;
  study: Omit<SensitivityStudy, "parameter" | "solve_options"> & { parameterKey: string };
}
