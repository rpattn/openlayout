use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
