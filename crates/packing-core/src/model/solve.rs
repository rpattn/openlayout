use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    /// Stop after learned lattice/motif construction and contact completion, before the
    /// rotation portfolio, continuation, neighbourhood, and beam phases.
    #[serde(default)]
    pub baseline_only: bool,
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
            baseline_only: false,
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
    pub overlap_repair_attempts: u64,
    #[serde(default)]
    pub overlap_repair_evaluated_moves: u64,
    #[serde(default)]
    pub overlap_repair_accepted_moves: u64,
    #[serde(default)]
    pub overlap_repair_weight_updates: u64,
    #[serde(default)]
    pub overlap_repair_successes: u64,
    #[serde(default)]
    pub overlap_repair_best_penalty: Option<f64>,
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
    OverlapRepair,
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
