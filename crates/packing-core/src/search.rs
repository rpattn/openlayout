use crate::clock::Clock;
use crate::geometry::{Bounds, EPSILON, PolygonSet, bounds, set_inside, sets_conflict, transform};
use crate::numeric::angular_distance;
use crate::{
    ConflictGraphStatus, Placement, PreparedProblem, SolveObserver, SolveOptions, SolvePhase,
    SolveProgress, SolveQuality,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub(crate) struct SearchMetrics {
    pub candidate_generation_ms: u64,
    pub containment_check_ms: u64,
    pub collision_check_ms: u64,
    pub candidate_scoring_ms: u64,
    pub generated_candidates: u64,
    pub evaluated_candidates: u64,
    pub valid_candidates: u64,
    pub broad_phase_rejections: u64,
    pub exact_geometry_checks: u64,
    pub accepted_placements: u64,
    pub explored_states: u64,
    pub deduplicated_states: u64,
    pub pruned_states: u64,
    pub area_bound_prunes: u64,
    pub region_bound_prunes: u64,
    pub projection_bound_prunes: u64,
    pub conflict_graph_candidates: usize,
    pub conflict_graph_status: ConflictGraphStatus,
    pub limit_reached: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SearchOutcome {
    pub placements: Vec<Placement>,
    pub upper_bound: usize,
    pub strategy: String,
    pub metrics: SearchMetrics,
}

#[derive(Clone)]
struct Placed {
    placement: Placement,
    variant_id: usize,
    geometry: Arc<PolygonSet>,
    bounds: Bounds,
}

#[derive(Clone)]
struct SearchState {
    placed: Vec<Placed>,
    counts: Vec<u32>,
    upper_bound: usize,
    secondary_score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CandidateSource {
    BoundaryContact,
    ExclusionContact,
    ItemContact,
    RegionExtremum,
    Structured,
}

#[derive(Debug, Clone)]
struct Candidate {
    id: u64,
    variant_id: usize,
    x: f64,
    y: f64,
    bounds: Bounds,
    source: CandidateSource,
    contact_support: u16,
    score: f64,
}

#[derive(Debug, Clone, Copy)]
enum CandidateOrigin {
    Static(usize),
    Dynamic(usize),
}

#[derive(Debug, Clone, Copy)]
struct CandidateRef {
    origin: CandidateOrigin,
    source: CandidateSource,
    contact_support: u16,
    score: f64,
    id: u64,
}

struct CandidateBatch {
    references: Vec<CandidateRef>,
    dynamic: Vec<Candidate>,
}

impl CandidateRef {
    fn candidate<'a>(
        &self,
        static_candidates: &'a [Candidate],
        dynamic: &'a [Candidate],
    ) -> &'a Candidate {
        match self.origin {
            CandidateOrigin::Static(index) => &static_candidates[index],
            CandidateOrigin::Dynamic(index) => &dynamic[index],
        }
    }
}

impl CandidateBatch {
    fn into_candidates(self) -> Vec<Candidate> {
        self.references
            .into_iter()
            .map(|reference| {
                let mut candidate = match reference.origin {
                    CandidateOrigin::Static(_) => unreachable!("root candidates are dynamic"),
                    CandidateOrigin::Dynamic(index) => self.dynamic[index].clone(),
                };
                candidate.source = reference.source;
                candidate.contact_support = reference.contact_support;
                candidate.score = reference.score;
                candidate.id = reference.id;
                candidate
            })
            .collect()
    }
}

#[derive(Clone)]
struct SearchConfig {
    beam_width: usize,
    candidates_per_state: usize,
    max_states: u64,
    grid_stride: f64,
    use_conflict_graph: bool,
    use_nfp_events: bool,
}

impl SearchConfig {
    fn from_options(options: &SolveOptions) -> Option<Self> {
        let mut config = match options.quality {
            SolveQuality::Fast if options.beam_width.is_none() => return None,
            SolveQuality::Fast => Self {
                beam_width: 1,
                candidates_per_state: 8,
                max_states: (options.max_iterations / 4).clamp(32, 5_000),
                grid_stride: options.grid_step * 2.0,
                use_conflict_graph: false,
                use_nfp_events: false,
            },
            SolveQuality::Balanced => Self {
                beam_width: 8,
                candidates_per_state: 12,
                max_states: (options.max_iterations / 3).clamp(64, 20_000),
                grid_stride: options.grid_step * 2.0,
                use_conflict_graph: false,
                use_nfp_events: false,
            },
            SolveQuality::Thorough => Self {
                beam_width: 24,
                candidates_per_state: 24,
                max_states: options.max_iterations.clamp(256, 120_000),
                grid_stride: options.grid_step,
                use_conflict_graph: true,
                use_nfp_events: true,
            },
        };
        config.beam_width = options.beam_width.unwrap_or(config.beam_width);
        config.candidates_per_state = options
            .max_candidates_per_state
            .unwrap_or(config.candidates_per_state);
        config.max_states = options.max_search_states.unwrap_or(config.max_states);
        if let Some(density) = options.candidate_generation_density {
            config.grid_stride = options.grid_step / density;
        }
        Some(config)
    }
}

pub(crate) fn bounded_search(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    baseline: &[Placement],
    target_count: Option<usize>,
    observer: &mut dyn SolveObserver,
) -> Option<SearchOutcome> {
    let config = SearchConfig::from_options(options)?;
    let fixed = placements_to_search(
        prepared,
        &baseline
            .iter()
            .filter(|p| p.fixed)
            .cloned()
            .collect::<Vec<_>>(),
    )?;
    let baseline_search = placements_to_search(prepared, baseline)?;
    let mut best = SearchState::from_placed(prepared, baseline_search.clone());
    let root = SearchState::from_placed(prepared, fixed);
    let root_upper_bound = root.upper_bound;
    let mut metrics = SearchMetrics::default();
    let search_started = Clock::start();
    let mut beam = vec![root.clone()];
    beam.extend(neighbourhood_starts(
        prepared,
        &baseline_search,
        &config,
        options.seed,
    ));
    let mut depth = 0usize;
    observer.on_progress(&SolveProgress {
        phase: SolvePhase::GeneratingCandidates,
        completed_fraction: 0.0,
        max_iterations: config.max_states,
        iterations: 0,
        packed_item_count: best.placed.len(),
        placements: best.placed.iter().map(|p| p.placement.clone()).collect(),
        solver_strategy: "contact_candidates".to_string(),
    });
    let static_candidates =
        generate_candidates(prepared, &root, &config, &mut metrics, observer, None)?
            .into_candidates();

    'search: while !beam.is_empty() && metrics.explored_states < config.max_states {
        if target_count.is_some_and(|target| best.placed.len() >= target) {
            break;
        }
        if observer.should_cancel() {
            metrics.cancelled = true;
            break;
        }
        if time_limit_reached(options, search_started) {
            metrics.limit_reached = true;
            break;
        }
        let mut next_states = Vec::new();
        let mut signatures = BTreeSet::new();
        for state in &beam {
            if state.upper_bound <= best.placed.len() {
                metrics.pruned_states += 1;
                record_bound_prune(prepared, state.upper_bound, &mut metrics);
                continue;
            }
            let Some(mut candidates) = generate_candidates(
                prepared,
                state,
                &config,
                &mut metrics,
                observer,
                Some(&static_candidates),
            ) else {
                break 'search;
            };
            score_candidates(
                prepared,
                state,
                &static_candidates,
                &mut candidates,
                &mut metrics,
            );
            let candidate_references = diverse_candidate_frontier(
                candidates.references,
                config.candidates_per_state.saturating_mul(24),
            );
            let spatial = SpatialIndex::new(
                state,
                prepared.minimum_item_area.sqrt().max(config.grid_stride),
            );
            let mut expanded = 0usize;
            for (candidate_index, reference) in candidate_references.into_iter().enumerate() {
                let candidate = reference.candidate(&static_candidates, &candidates.dynamic);
                if candidate_index.is_multiple_of(256) && observer.should_cancel() {
                    metrics.cancelled = true;
                    break 'search;
                }
                if candidate_index.is_multiple_of(256)
                    && time_limit_reached(options, search_started)
                {
                    metrics.limit_reached = true;
                    break 'search;
                }
                if metrics.explored_states >= config.max_states {
                    metrics.limit_reached = true;
                    break;
                }
                let Some(placed) =
                    feasible_candidate(prepared, state, &spatial, candidate, &mut metrics)
                else {
                    continue;
                };
                metrics.explored_states += 1;
                expanded += 1;
                metrics.accepted_placements += 1;
                let mut child = state.clone();
                child.counts[prepared.variants[placed.variant_id].item_index] += 1;
                child.placed.push(placed);
                child.upper_bound = optimistic_upper_bound(prepared, &child);
                child.secondary_score = state_secondary_score(&child);
                if better_state(&child, &best) {
                    best = child.clone();
                }
                if target_count.is_some_and(|target| best.placed.len() >= target) {
                    break 'search;
                }
                if child.upper_bound <= best.placed.len() {
                    metrics.pruned_states += 1;
                    record_bound_prune(prepared, child.upper_bound, &mut metrics);
                    continue;
                }
                let signature = state_signature(&child);
                if !signatures.insert(signature) {
                    metrics.deduplicated_states += 1;
                    continue;
                }
                next_states.push(child);
                if expanded >= config.candidates_per_state {
                    break;
                }
            }
        }
        next_states.sort_by(compare_states);
        next_states.truncate(config.beam_width);
        beam = next_states;
        depth += 1;
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::BeamSearch,
            completed_fraction: (metrics.explored_states as f64 / config.max_states as f64)
                .clamp(0.0, 1.0),
            max_iterations: config.max_states,
            iterations: metrics.explored_states,
            packed_item_count: best.placed.len(),
            placements: best.placed.iter().map(|p| p.placement.clone()).collect(),
            solver_strategy: "bounded_beam".to_string(),
        });
        if depth >= prepared.simple_upper_bound.unwrap_or(usize::MAX) {
            break;
        }
    }

    if metrics.explored_states >= config.max_states {
        metrics.limit_reached = true;
    }
    let mut strategy = "bounded_beam".to_string();
    let refine_graph = config.use_conflict_graph
        && root_upper_bound.saturating_sub(best.placed.len()) <= 2
        && target_count.is_none();
    if refine_graph {
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::ConflictGraph,
            completed_fraction: 0.0,
            max_iterations: config.max_states,
            iterations: metrics.explored_states,
            packed_item_count: best.placed.len(),
            placements: best.placed.iter().map(|p| p.placement.clone()).collect(),
            solver_strategy: "conflict_graph".to_string(),
        });
    }
    if refine_graph
        && let Some(graph_result) =
            conflict_graph_refine(prepared, &config, &best, &mut metrics, observer)
        && better_state(&graph_result, &best)
    {
        best = graph_result;
        strategy.push_str("+conflict_graph");
    }

    Some(SearchOutcome {
        placements: best
            .placed
            .into_iter()
            .map(|entry| entry.placement)
            .collect(),
        upper_bound: root_upper_bound,
        strategy,
        metrics,
    })
}

fn diverse_candidate_frontier(candidates: Vec<CandidateRef>, limit: usize) -> Vec<CandidateRef> {
    let mut buckets: BTreeMap<CandidateSource, VecDeque<CandidateRef>> = BTreeMap::new();
    for candidate in candidates {
        buckets
            .entry(candidate.source)
            .or_default()
            .push_back(candidate);
    }
    let source_order = [
        CandidateSource::ItemContact,
        CandidateSource::RegionExtremum,
        CandidateSource::Structured,
        CandidateSource::BoundaryContact,
        CandidateSource::ExclusionContact,
    ];
    let mut frontier = Vec::with_capacity(limit);
    while frontier.len() < limit {
        let mut added = false;
        for source in source_order {
            if let Some(candidate) = buckets.get_mut(&source).and_then(VecDeque::pop_front) {
                frontier.push(candidate);
                added = true;
                if frontier.len() == limit {
                    break;
                }
            }
        }
        if !added {
            break;
        }
    }
    frontier
}

fn neighbourhood_starts(
    prepared: &PreparedProblem,
    baseline: &[Placed],
    config: &SearchConfig,
    seed: u64,
) -> Vec<SearchState> {
    let movable = baseline
        .iter()
        .enumerate()
        .filter(|(_, placed)| !placed.placement.fixed)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if movable.len() < 4 {
        return Vec::new();
    }
    let maximum_starts = if config.beam_width >= 16 { 24 } else { 6 };
    let mut anchors = movable.clone();
    anchors.sort_by(|a, b| {
        baseline[*b]
            .bounds
            .max_y
            .total_cmp(&baseline[*a].bounds.max_y)
            .then_with(|| {
                baseline[*b]
                    .bounds
                    .max_x
                    .total_cmp(&baseline[*a].bounds.max_x)
            })
            .then_with(|| a.cmp(b))
    });
    if let Some(rightmost) = movable.iter().max_by(|a, b| {
        baseline[**a]
            .bounds
            .max_x
            .total_cmp(&baseline[**b].bounds.max_x)
    }) {
        anchors.insert(0, *rightmost);
    }
    for exclusion in &prepared.exclusions {
        let exclusion_bounds = bounds(exclusion);
        let center_x = (exclusion_bounds.min_x + exclusion_bounds.max_x) / 2.0;
        let center_y = (exclusion_bounds.min_y + exclusion_bounds.max_y) / 2.0;
        if let Some(closest) = movable.iter().min_by(|a, b| {
            center_distance_squared(&baseline[**a], center_x, center_y)
                .total_cmp(&center_distance_squared(&baseline[**b], center_x, center_y))
        }) {
            anchors.insert(0, *closest);
        }
    }
    for polygon in &prepared.container.polygons {
        for index in 0..polygon.len() {
            let previous = polygon[(index + polygon.len() - 1) % polygon.len()];
            let vertex = polygon[index];
            let next = polygon[(index + 1) % polygon.len()];
            let turn = (vertex.x - previous.x) * (next.y - vertex.y)
                - (vertex.y - previous.y) * (next.x - vertex.x);
            if turn < -EPSILON
                && let Some(closest) = movable.iter().min_by(|a, b| {
                    center_distance_squared(&baseline[**a], vertex.x, vertex.y)
                        .total_cmp(&center_distance_squared(&baseline[**b], vertex.x, vertex.y))
                })
            {
                anchors.insert(0, *closest);
            }
        }
    }
    // A small deterministic pseudo-random sample reaches interior decisions that extrema-based
    // anchors miss while preserving exact repeatability for a given seed.
    let mut value = seed;
    for _ in 0..3.min(movable.len()) {
        value = value.wrapping_mul(6364136223846793005).wrapping_add(1);
        anchors.push(movable[value as usize % movable.len()]);
    }

    let mut states = Vec::new();
    let mut signatures = BTreeSet::new();
    for anchor in anchors {
        let anchor_x = (baseline[anchor].bounds.min_x + baseline[anchor].bounds.max_x) / 2.0;
        let anchor_y = (baseline[anchor].bounds.min_y + baseline[anchor].bounds.max_y) / 2.0;
        let mut nearest = movable
            .iter()
            .copied()
            .map(|index| {
                (
                    center_distance_squared(&baseline[index], anchor_x, anchor_y),
                    index,
                )
            })
            .collect::<Vec<_>>();
        nearest.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let maximum_neighbourhood = 8.min(movable.len());
        for neighbourhood_size in 2..=maximum_neighbourhood {
            let removed = nearest
                .iter()
                .take(neighbourhood_size)
                .map(|(_, index)| *index)
                .collect::<BTreeSet<_>>();
            let state = SearchState::from_placed(
                prepared,
                baseline
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| !removed.contains(index))
                    .map(|(_, placed)| placed.clone())
                    .collect(),
            );
            if signatures.insert(state_signature(&state)) {
                states.push(state);
                if states.len() >= maximum_starts {
                    return states;
                }
            }
        }
    }
    states
}

fn center_distance_squared(placed: &Placed, x: f64, y: f64) -> f64 {
    let center_x = (placed.bounds.min_x + placed.bounds.max_x) / 2.0;
    let center_y = (placed.bounds.min_y + placed.bounds.max_y) / 2.0;
    (center_x - x).powi(2) + (center_y - y).powi(2)
}

impl SearchState {
    fn from_placed(prepared: &PreparedProblem, placed: Vec<Placed>) -> Self {
        let mut counts = vec![0; prepared.problem.items.len()];
        for entry in &placed {
            counts[prepared.variants[entry.variant_id].item_index] += 1;
        }
        let mut state = Self {
            placed,
            counts,
            upper_bound: 0,
            secondary_score: 0.0,
        };
        state.upper_bound = optimistic_upper_bound(prepared, &state);
        state.secondary_score = state_secondary_score(&state);
        state
    }
}

fn placements_to_search(
    prepared: &PreparedProblem,
    placements: &[Placement],
) -> Option<Vec<Placed>> {
    placements
        .iter()
        .map(|placement| {
            let variant = prepared.variants.iter().find(|variant| {
                variant.item_id == placement.item_id
                    && angular_distance(variant.rotation_deg, placement.rotation_deg) <= EPSILON
            })?;
            Some(Placed {
                placement: placement.clone(),
                variant_id: variant.id,
                geometry: Arc::new(transform(&variant.geometry, 0.0, placement.x, placement.y)),
                bounds: variant.bounds.translated(placement.x, placement.y),
            })
        })
        .collect()
}

mod candidate_pipeline;
use candidate_pipeline::{SpatialIndex, feasible_candidate, generate_candidates, score_candidates};

fn optimistic_upper_bound(prepared: &PreparedProblem, state: &SearchState) -> usize {
    let remaining_quantity = prepared
        .problem
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.quantity as usize).saturating_sub(state.counts[index] as usize))
        .sum::<usize>();
    let minimum_remaining_area = prepared
        .variants
        .iter()
        .filter(|variant| {
            state.counts[variant.item_index] < prepared.problem.items[variant.item_index].quantity
        })
        .map(|variant| variant.occupied_area)
        .fold(f64::INFINITY, f64::min);
    if !minimum_remaining_area.is_finite() || minimum_remaining_area <= 0.0 {
        return state.placed.len();
    }
    let occupied = state
        .placed
        .iter()
        .map(|placed| prepared.variants[placed.variant_id].occupied_area)
        .sum::<f64>();
    let remaining_area = (prepared.usable_area - occupied).max(0.0);
    let area_capacity = ((remaining_area + EPSILON) / minimum_remaining_area)
        .floor()
        .max(0.0) as usize;
    let area_upper = state.placed.len() + remaining_quantity.min(area_capacity);
    [
        Some(area_upper),
        prepared.region_upper_bound,
        prepared.projection_upper_bound,
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(area_upper)
}

fn record_bound_prune(prepared: &PreparedProblem, upper_bound: usize, metrics: &mut SearchMetrics) {
    if prepared.projection_upper_bound == Some(upper_bound) {
        metrics.projection_bound_prunes += 1;
    } else if prepared.region_upper_bound == Some(upper_bound) {
        metrics.region_bound_prunes += 1;
    } else {
        metrics.area_bound_prunes += 1;
    }
}

fn state_secondary_score(state: &SearchState) -> f64 {
    let max_x = state
        .placed
        .iter()
        .map(|p| p.bounds.max_x)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = state
        .placed
        .iter()
        .map(|p| p.bounds.max_y)
        .fold(f64::NEG_INFINITY, f64::max);
    if state.placed.is_empty() {
        0.0
    } else {
        -max_y * 1e-3 - max_x * 1e-6
    }
}

fn better_state(candidate: &SearchState, incumbent: &SearchState) -> bool {
    candidate.placed.len() > incumbent.placed.len()
        || (candidate.placed.len() == incumbent.placed.len()
            && (candidate.secondary_score > incumbent.secondary_score
                || (candidate.secondary_score == incumbent.secondary_score
                    && state_signature(candidate) < state_signature(incumbent))))
}

fn compare_states(a: &SearchState, b: &SearchState) -> std::cmp::Ordering {
    b.upper_bound
        .cmp(&a.upper_bound)
        .then_with(|| b.placed.len().cmp(&a.placed.len()))
        .then_with(|| b.secondary_score.total_cmp(&a.secondary_score))
        .then_with(|| state_signature(a).cmp(&state_signature(b)))
}

fn state_signature(state: &SearchState) -> Vec<(usize, i64, i64)> {
    let quantum = (EPSILON * 10.0).max(1e-8);
    let mut signature = state
        .placed
        .iter()
        .map(|placed| {
            (
                placed.variant_id,
                (placed.placement.x / quantum).round() as i64,
                (placed.placement.y / quantum).round() as i64,
            )
        })
        .collect::<Vec<_>>();
    signature.sort_unstable();
    signature
}

fn polygon_set_contact_points(set: &PolygonSet, limit: usize) -> Vec<crate::Point> {
    set.polygons
        .iter()
        .flat_map(|polygon| {
            polygon.iter().enumerate().flat_map(|(index, point)| {
                let next = polygon[(index + 1) % polygon.len()];
                [
                    *point,
                    crate::Point {
                        x: (point.x + next.x) / 2.0,
                        y: (point.y + next.y) / 2.0,
                    },
                ]
            })
        })
        .take(limit)
        .collect()
}

fn detailed_contact_limit(set: &PolygonSet) -> usize {
    let vertex_count = set.polygons.iter().map(Vec::len).sum::<usize>();
    if vertex_count <= 16 { 32 } else { 8 }
}

fn prefers_exact_fit_priority(set: &PolygonSet) -> bool {
    set.polygons.iter().map(Vec::len).sum::<usize>() <= 16
}

// The finite graph uses candidates generated without item contacts. It is deliberately bounded:
// graph optimality, when reported, applies only to this candidate set.
mod conflict_graph;
use conflict_graph::conflict_graph_refine;

fn time_limit_reached(options: &SolveOptions, started: Clock) -> bool {
    !options.deterministic
        && options
            .time_limit_ms
            .is_some_and(|limit| started.elapsed_ms() >= limit)
}
