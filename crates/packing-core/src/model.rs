use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
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
    Compound {
        parts: Vec<ShapePart>,
    },
}

fn default_circle_segments() -> u32 {
    32
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
    pub boundary: Shape,
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
    #[serde(default = "zero_rotation")]
    pub rotations: Vec<f64>,
}

fn unlimited_quantity() -> u32 {
    u32::MAX
}
fn zero_rotation() -> Vec<f64> {
    vec![0.0]
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
    3
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
    pub statistics: SolveStatistics,
    pub validation: ValidationReport,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SolveProgress {
    pub iterations: u64,
    pub packed_item_count: usize,
    pub placements: Vec<Placement>,
    pub solver_strategy: String,
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
