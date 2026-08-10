use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BezierKnot {
    pub point: Point,
    pub control_in: Point,
    pub control_out: Point,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Shape {
    Polygon {
        vertices: Vec<Point>,
    },
    Rectangle {
        width: f64,
        height: f64,
    },
    Triangle {
        base: f64,
        height: f64,
    },
    Circle {
        radius: f64,
        #[serde(default = "default_circle_segments")]
        segments: u32,
    },
    Bezier {
        knots: Vec<BezierKnot>,
        #[serde(default = "default_bezier_segments")]
        segments_per_curve: u32,
    },
    Compound {
        parts: Vec<ShapePart>,
    },
}

fn default_circle_segments() -> u32 {
    32
}

fn default_bezier_segments() -> u32 {
    12
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapePart {
    pub shape: Box<Shape>,
    #[serde(default)]
    pub translation: Point,
    #[serde(default)]
    pub rotation_deg: f64,
    #[serde(default)]
    pub snap: Option<PartSnap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapeAnchor {
    Center,
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartSnap {
    pub target_part: usize,
    pub own_anchor: ShapeAnchor,
    pub target_anchor: ShapeAnchor,
    #[serde(default)]
    pub offset: Point,
}

impl Default for Point {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Container {
    #[serde(default)]
    pub parts: Vec<RegionPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionOperation {
    Add,
    Subtract,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegionPart {
    pub id: String,
    pub operation: RegionOperation,
    pub shape: Shape,
    #[serde(default)]
    pub translation: Point,
    #[serde(default)]
    pub rotation_deg: f64,
    #[serde(default)]
    pub snap: Option<PartSnap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedResolvedGeometry {
    pub id: String,
    pub polygons: Vec<Vec<Point>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedProblemGeometry {
    pub container: Vec<Vec<Point>>,
    pub items: Vec<NamedResolvedGeometry>,
    pub exclusions: Vec<NamedResolvedGeometry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Exclusion {
    pub id: String,
    pub shape: Shape,
    #[serde(default)]
    pub clearance: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub shape: Shape,
    #[serde(default = "unlimited_quantity")]
    pub quantity: u32,
    #[serde(default)]
    pub rotation_policy: RotationPolicy,
}

fn unlimited_quantity() -> u32 {
    u32::MAX
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationCoupling {
    Independent,
    SharedPerItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RotationPolicy {
    Discrete {
        angles_deg: Vec<f64>,
        coupling: RotationCoupling,
    },
    Continuous {
        #[serde(default)]
        min_deg: f64,
        #[serde(default = "full_rotation")]
        max_deg: f64,
        coupling: RotationCoupling,
    },
}

impl Default for RotationPolicy {
    fn default() -> Self {
        Self::Discrete {
            angles_deg: vec![0.0],
            coupling: RotationCoupling::Independent,
        }
    }
}

fn full_rotation() -> f64 {
    360.0
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Clearance {
    #[serde(default)]
    pub item_to_item: f64,
    #[serde(default)]
    pub item_to_boundary: f64,
    #[serde(default)]
    pub item_to_exclusion: f64,
}

impl Default for Clearance {
    fn default() -> Self {
        Self {
            item_to_item: 0.0,
            item_to_boundary: 0.0,
            item_to_exclusion: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixedPlacement {
    pub item_id: String,
    pub x: f64,
    pub y: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackingProblem {
    #[serde(default)]
    pub schema_version: u32,
    pub container: Container,
    #[serde(default)]
    pub exclusions: Vec<Exclusion>,
    pub items: Vec<Item>,
    #[serde(default)]
    pub fixed_placements: Vec<FixedPlacement>,
    #[serde(default)]
    pub clearance: Clearance,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SolveOptions {
    #[serde(default = "default_seed")]
    pub seed: u64,
    #[serde(default = "deterministic_true")]
    pub deterministic: bool,
    #[serde(default = "default_iterations")]
    pub max_iterations: u64,
    #[serde(default)]
    pub time_limit_ms: Option<u64>,
    #[serde(default = "default_grid_step")]
    pub grid_step: f64,
    #[serde(default = "default_restarts")]
    pub restarts: u32,
    #[serde(default)]
    pub quality: SolveQuality,
    #[serde(default)]
    pub beam_width: Option<usize>,
    #[serde(default)]
    pub max_candidates_per_state: Option<usize>,
    #[serde(default)]
    pub max_search_states: Option<u64>,
    #[serde(default)]
    pub candidate_generation_density: Option<f64>,
}

fn default_seed() -> u64 {
    1
}
fn deterministic_true() -> bool {
    true
}
fn default_iterations() -> u64 {
    100_000
}
fn default_grid_step() -> f64 {
    1.0
}
fn default_restarts() -> u32 {
    4
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SolveQuality {
    Fast,
    #[default]
    Balanced,
    Thorough,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            seed: default_seed(),
            deterministic: deterministic_true(),
            max_iterations: default_iterations(),
            time_limit_ms: None,
            grid_step: default_grid_step(),
            restarts: default_restarts(),
            quality: SolveQuality::default(),
            beam_width: None,
            max_candidates_per_state: None,
            max_search_states: None,
            candidate_generation_density: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub item_id: String,
    pub x: f64,
    pub y: f64,
    pub rotation_deg: f64,
    pub fixed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolveStatus {
    Feasible,
    BestFound,
    ProvenOptimal,
    Infeasible,
    Cancelled,
    LimitReached,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValidationReport {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolveStatistics {
    pub candidates_evaluated: u64,
    pub valid_candidates: u64,
    pub iterations: u64,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub preparation_ms: u64,
    #[serde(default)]
    pub candidate_generation_ms: u64,
    #[serde(default)]
    pub containment_check_ms: u64,
    #[serde(default)]
    pub collision_check_ms: u64,
    #[serde(default)]
    pub candidate_scoring_ms: u64,
    #[serde(default)]
    pub subdivision_ms: u64,
    #[serde(default)]
    pub generated_candidates: u64,
    #[serde(default)]
    pub broad_phase_rejections: u64,
    #[serde(default)]
    pub exact_geometry_checks: u64,
    #[serde(default)]
    pub accepted_placements: u64,
    #[serde(default)]
    pub explored_search_states: u64,
    #[serde(default)]
    pub deduplicated_search_states: u64,
    #[serde(default)]
    pub pruned_search_states: u64,
    #[serde(default)]
    pub area_bound_prunes: u64,
    #[serde(default)]
    pub region_bound_prunes: u64,
    #[serde(default)]
    pub projection_bound_prunes: u64,
    #[serde(default)]
    pub greedy_lower_bound: usize,
    #[serde(default)]
    pub final_upper_bound: Option<usize>,
    #[serde(default)]
    pub bound_gap: Option<usize>,
    #[serde(default)]
    pub local_improvement_attempts: u64,
    #[serde(default)]
    pub local_improvements_accepted: u64,
    #[serde(default)]
    pub continuation_stages: u64,
    #[serde(default)]
    pub continuation_repair_only_stages: u64,
    #[serde(default)]
    pub continuation_search_stages: u64,
    #[serde(default)]
    pub continuation_full_solve_stages: u64,
    #[serde(default)]
    pub conflict_graph_candidates: usize,
    #[serde(default)]
    pub conflict_graph_status: ConflictGraphStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConflictGraphStatus {
    #[default]
    NotRun,
    BestFound,
    CandidateSetOptimal,
    LimitReached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WarmStartStatus {
    #[default]
    FromEmpty,
    Retained,
    PartiallyRepaired,
    Restarted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolveResult {
    pub layout_id: String,
    pub status: SolveStatus,
    pub placements: Vec<Placement>,
    pub packed_item_count: usize,
    pub packed_count_by_item: BTreeMap<String, usize>,
    pub objective_score: f64,
    pub simple_upper_bound: Option<usize>,
    pub seed: u64,
    pub solver_strategy: String,
    pub selected_shared_angles: BTreeMap<String, f64>,
    pub statistics: SolveStatistics,
    #[serde(default)]
    pub strategies_used: Vec<String>,
    #[serde(default)]
    pub warm_start_status: WarmStartStatus,
    pub validation: ValidationReport,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolveProgress {
    pub phase: SolvePhase,
    pub completed_fraction: f64,
    pub max_iterations: u64,
    pub iterations: u64,
    pub packed_item_count: usize,
    pub placements: Vec<Placement>,
    pub solver_strategy: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolvePhase {
    PreparingGeometry,
    GeneratingCandidates,
    Baseline,
    BeamSearch,
    CoarseRotation,
    AngleRefinement,
    NeighbourhoodImprovement,
    ClearanceContinuation,
    ConflictGraph,
    Validating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeasibilityStatus {
    Feasible,
    ImpossibleByBound,
    NotFoundWithinLimit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeasibilityResult {
    pub status: FeasibilityStatus,
    pub target_count: usize,
    pub result: Option<SolveResult>,
    pub valid_upper_bound: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParameterPath {
    ItemWidth { item_id: String },
    ItemHeight { item_id: String },
    ItemScale { item_id: String },
    ItemPartWidth { item_id: String, part_index: usize },
    ItemPartHeight { item_id: String, part_index: usize },
    ItemPartRadius { item_id: String, part_index: usize },
    ItemPartScale { item_id: String, part_index: usize },
    ClearanceItemToItem,
    ClearanceItemToBoundary,
    ContainerWidth,
    ContainerHeight,
    ItemQuantity { item_id: String },
    ContainerPartWidth { part_id: String },
    ContainerPartHeight { part_id: String },
    ContainerPartScale { part_id: String },
    ExclusionScale { exclusion_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingStrategy {
    Sampled,
    Adaptive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedPolicy {
    Fixed,
    DeriveFromValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensitivityStudy {
    pub parameter: ParameterPath,
    pub start: f64,
    pub end: f64,
    pub initial_step: f64,
    #[serde(default = "default_transition_tolerance")]
    pub transition_tolerance: f64,
    pub strategy: SamplingStrategy,
    #[serde(default)]
    pub solve_options: SolveOptions,
    #[serde(default = "fixed_seed_policy")]
    pub seed_policy: SeedPolicy,
    #[serde(default = "monotonic_true")]
    pub increasing_is_harder: bool,
}

fn default_transition_tolerance() -> f64 {
    0.01
}
fn fixed_seed_policy() -> SeedPolicy {
    SeedPolicy::Fixed
}
fn monotonic_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensitivityPoint {
    pub value: f64,
    pub capacity: usize,
    pub status: SolveStatus,
    pub problem: PackingProblem,
    pub result: SolveResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensitivityProgress {
    pub completed: usize,
    pub initial_total: usize,
    pub value: f64,
    pub capacity: usize,
    pub phase: SensitivityPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitivityPhase {
    Sampling,
    Refining,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionInterval {
    pub lower_value: f64,
    pub upper_value: f64,
    pub lower_capacity: usize,
    pub upper_capacity: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensitivityResult {
    pub evaluations: Vec<SensitivityPoint>,
    pub representative_layouts: BTreeMap<usize, SolveResult>,
    pub transitions: Vec<TransitionInterval>,
    pub warnings: Vec<String>,
}
