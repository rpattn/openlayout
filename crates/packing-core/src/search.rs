use crate::geometry::{
    Bounds, EPSILON, PolygonSet, bounds, set_distance, set_inside, sets_overlap, transform,
};
use crate::{
    ConflictGraphStatus, Placement, PreparedProblem, SolveObserver, SolveOptions, SolvePhase,
    SolveProgress, SolveQuality,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

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
    geometry: PolygonSet,
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
    score: f64,
}

#[derive(Clone)]
struct SearchConfig {
    beam_width: usize,
    candidates_per_state: usize,
    max_states: u64,
    grid_stride: f64,
    use_conflict_graph: bool,
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
            },
            SolveQuality::Balanced => Self {
                beam_width: 8,
                candidates_per_state: 12,
                max_states: (options.max_iterations / 3).clamp(64, 20_000),
                grid_stride: options.grid_step * 2.0,
                use_conflict_graph: false,
            },
            SolveQuality::Thorough => Self {
                beam_width: 24,
                candidates_per_state: 24,
                max_states: options.max_iterations.clamp(256, 120_000),
                grid_stride: options.grid_step,
                use_conflict_graph: true,
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
    let search_started = metric_clock_start();
    let mut beam = vec![root];
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
            let Some(mut candidates) =
                generate_candidates(prepared, state, &config, &mut metrics, observer)
            else {
                break 'search;
            };
            score_candidates(prepared, state, &mut candidates, &mut metrics);
            let candidates = diverse_candidate_frontier(
                candidates,
                config.candidates_per_state.saturating_mul(24),
            );
            let spatial = SpatialIndex::new(
                state,
                prepared.minimum_item_area.sqrt().max(config.grid_stride),
            );
            let mut expanded = 0usize;
            for (candidate_index, candidate) in candidates.into_iter().enumerate() {
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
                    feasible_candidate(prepared, state, &spatial, &candidate, &mut metrics)
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

fn diverse_candidate_frontier(candidates: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
    let mut buckets: BTreeMap<CandidateSource, VecDeque<Candidate>> = BTreeMap::new();
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
                geometry: transform(&variant.geometry, 0.0, placement.x, placement.y),
                bounds: variant.bounds.translated(placement.x, placement.y),
            })
        })
        .collect()
}

fn generate_candidates(
    prepared: &PreparedProblem,
    state: &SearchState,
    config: &SearchConfig,
    metrics: &mut SearchMetrics,
    observer: &mut dyn SolveObserver,
) -> Option<Vec<Candidate>> {
    let started = metric_clock_start();
    let mut raw = Vec::new();
    let boundary_points = prepared
        .container_contacts
        .iter()
        .take(32)
        .copied()
        .collect::<Vec<_>>();
    let exclusion_points = prepared
        .exclusion_contacts
        .iter()
        .take(24)
        .copied()
        .collect::<Vec<_>>();
    for variant in &prepared.variants {
        if observer.should_cancel() {
            metrics.cancelled = true;
            return None;
        }
        let item_index = variant.item_index;
        if state.counts[item_index] >= prepared.problem.items[item_index].quantity {
            continue;
        }
        let boundary_gap = prepared.problem.clearance.item_to_boundary + EPSILON * 10.0;
        let mut positions = Vec::new();
        positions.extend([
            (
                prepared.container_bounds.min_x + boundary_gap - variant.bounds.min_x,
                prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y,
                CandidateSource::RegionExtremum,
            ),
            (
                prepared.container_bounds.max_x - boundary_gap - variant.bounds.max_x,
                prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y,
                CandidateSource::RegionExtremum,
            ),
            (
                prepared.container_bounds.min_x + boundary_gap - variant.bounds.min_x,
                prepared.container_bounds.max_y - boundary_gap - variant.bounds.max_y,
                CandidateSource::RegionExtremum,
            ),
            (
                prepared.container_bounds.max_x - boundary_gap - variant.bounds.max_x,
                prepared.container_bounds.max_y - boundary_gap - variant.bounds.max_y,
                CandidateSource::RegionExtremum,
            ),
        ]);
        let item_points = contact_points(&variant.geometry, 16);
        for boundary in &boundary_points {
            for item in &item_points {
                positions.push((
                    boundary.x - item.x,
                    boundary.y - item.y,
                    CandidateSource::BoundaryContact,
                ));
            }
        }
        for boundary in &exclusion_points {
            for item in item_points.iter().take(8) {
                positions.push((
                    boundary.x - item.x,
                    boundary.y - item.y,
                    CandidateSource::ExclusionContact,
                ));
            }
        }
        let gap = prepared.problem.clearance.item_to_item + EPSILON * 10.0;
        let mut contact_xs = Vec::new();
        let mut contact_ys = Vec::new();
        for existing in &state.placed {
            contact_xs.extend([
                existing.bounds.max_x + gap - variant.bounds.min_x,
                existing.bounds.min_x - gap - variant.bounds.max_x,
            ]);
            contact_ys.extend([
                existing.bounds.max_y + gap - variant.bounds.min_y,
                existing.bounds.min_y - gap - variant.bounds.max_y,
            ]);
            positions.extend([
                (
                    existing.bounds.max_x + gap - variant.bounds.min_x,
                    existing.placement.y,
                    CandidateSource::ItemContact,
                ),
                (
                    existing.bounds.min_x - gap - variant.bounds.max_x,
                    existing.placement.y,
                    CandidateSource::ItemContact,
                ),
                (
                    existing.placement.x,
                    existing.bounds.max_y + gap - variant.bounds.min_y,
                    CandidateSource::ItemContact,
                ),
                (
                    existing.placement.x,
                    existing.bounds.min_y - gap - variant.bounds.max_y,
                    CandidateSource::ItemContact,
                ),
            ]);
            let existing_points = contact_points(&existing.geometry, 8);
            for anchor in existing_points {
                for item in item_points.iter().take(8) {
                    positions.push((
                        anchor.x - item.x,
                        anchor.y - item.y,
                        CandidateSource::ItemContact,
                    ));
                }
            }
        }
        // Combining an x-contact from one obstacle with a y-contact from another produces the
        // finite two-constraint intersections that often close a corner-shaped gap.
        for x in contact_xs.into_iter().take(12) {
            for y in contact_ys.iter().take(12) {
                positions.push((x, *y, CandidateSource::ItemContact));
            }
        }
        let mut y = prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y;
        let mut row_index = 0usize;
        while y + variant.bounds.max_y <= prepared.container_bounds.max_y - boundary_gap + EPSILON {
            if row_index.is_multiple_of(64) && observer.should_cancel() {
                metrics.cancelled = true;
                return None;
            }
            let mut x = prepared.container_bounds.min_x + boundary_gap - variant.bounds.min_x;
            while x + variant.bounds.max_x
                <= prepared.container_bounds.max_x - boundary_gap + EPSILON
            {
                positions.push((x, y, CandidateSource::Structured));
                x += config.grid_stride;
            }
            y += config.grid_stride;
            row_index += 1;
        }
        positions.sort_by(|a, b| {
            a.2.cmp(&b.2)
                .then_with(|| a.1.total_cmp(&b.1))
                .then_with(|| a.0.total_cmp(&b.0))
        });
        let quantum = (EPSILON * 100.0).max(1e-7);
        let mut seen = BTreeSet::new();
        for (x, y, source) in positions {
            if !x.is_finite() || !y.is_finite() {
                continue;
            }
            let key = ((x / quantum).round() as i64, (y / quantum).round() as i64);
            if !seen.insert(key) {
                continue;
            }
            raw.push(Candidate {
                id: 0,
                variant_id: variant.id,
                x,
                y,
                bounds: variant.bounds.translated(x, y),
                source,
                score: 0.0,
            });
        }
    }
    raw.sort_by(|a, b| {
        a.variant_id
            .cmp(&b.variant_id)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.y.total_cmp(&b.y))
            .then_with(|| a.x.total_cmp(&b.x))
    });
    for (id, candidate) in raw.iter_mut().enumerate() {
        candidate.id = id as u64;
    }
    metrics.generated_candidates += raw.len() as u64;
    metrics.candidate_generation_ms += metric_elapsed_ms(started);
    Some(raw)
}

fn score_candidates(
    prepared: &PreparedProblem,
    state: &SearchState,
    candidates: &mut [Candidate],
    metrics: &mut SearchMetrics,
) {
    let started = metric_clock_start();
    for candidate in candidates.iter_mut() {
        let contact_bonus = match candidate.source {
            CandidateSource::ItemContact => 20.0,
            CandidateSource::RegionExtremum => 15.0,
            CandidateSource::Structured => 10.0,
            CandidateSource::BoundaryContact => 3.0,
            CandidateSource::ExclusionContact => 2.0,
        };
        let x = candidate.bounds.min_x - prepared.container_bounds.min_x;
        let y = candidate.bounds.min_y - prepared.container_bounds.min_y;
        let alignment = state
            .placed
            .iter()
            .filter(|placed| {
                (placed.bounds.min_x - candidate.bounds.min_x).abs() <= EPSILON * 10.0
                    || (placed.bounds.min_y - candidate.bounds.min_y).abs() <= EPSILON * 10.0
            })
            .count() as f64;
        candidate.score = contact_bonus + alignment * 0.25 - y * 1e-3 - x * 1e-6;
    }
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.y.total_cmp(&b.y))
            .then_with(|| a.x.total_cmp(&b.x))
            .then_with(|| a.variant_id.cmp(&b.variant_id))
            .then_with(|| a.id.cmp(&b.id))
    });
    metrics.candidate_scoring_ms += metric_elapsed_ms(started);
}

fn feasible_candidate(
    prepared: &PreparedProblem,
    state: &SearchState,
    spatial: &SpatialIndex,
    candidate: &Candidate,
    metrics: &mut SearchMetrics,
) -> Option<Placed> {
    metrics.evaluated_candidates += 1;
    if !prepared.container_bounds.overlaps(candidate.bounds, 0.0)
        || candidate.bounds.min_x < prepared.container_bounds.min_x - EPSILON
        || candidate.bounds.max_x > prepared.container_bounds.max_x + EPSILON
        || candidate.bounds.min_y < prepared.container_bounds.min_y - EPSILON
        || candidate.bounds.max_y > prepared.container_bounds.max_y + EPSILON
    {
        metrics.broad_phase_rejections += 1;
        return None;
    }
    let variant = &prepared.variants[candidate.variant_id];
    let geometry = transform(&variant.geometry, 0.0, candidate.x, candidate.y);
    let containment_started = metric_clock_start();
    metrics.exact_geometry_checks += 1;
    let inside = set_inside(
        &geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    );
    metrics.containment_check_ms += metric_elapsed_ms(containment_started);
    if !inside {
        return None;
    }
    let collision_started = metric_clock_start();
    for (index, exclusion) in prepared.exclusions.iter().enumerate() {
        let required = prepared
            .problem
            .clearance
            .item_to_exclusion
            .max(prepared.problem.exclusions[index].clearance);
        if !candidate.bounds.overlaps(bounds(exclusion), required) {
            metrics.broad_phase_rejections += 1;
            continue;
        }
        metrics.exact_geometry_checks += 1;
        if sets_overlap(&geometry, exclusion)
            || set_distance(&geometry, exclusion) + EPSILON < required
        {
            metrics.collision_check_ms += metric_elapsed_ms(collision_started);
            return None;
        }
    }
    let item = &prepared.problem.items[variant.item_index];
    let shared_rotation = matches!(
        item.rotation_policy,
        crate::RotationPolicy::Discrete {
            coupling: crate::RotationCoupling::SharedPerItem,
            ..
        } | crate::RotationPolicy::Continuous {
            coupling: crate::RotationCoupling::SharedPerItem,
            ..
        }
    );
    if shared_rotation
        && state.placed.iter().any(|existing| {
            existing.placement.item_id == variant.item_id
                && angular_distance(existing.placement.rotation_deg, variant.rotation_deg) > EPSILON
        })
    {
        metrics.collision_check_ms += metric_elapsed_ms(collision_started);
        return None;
    }
    for index in spatial.query(candidate.bounds, prepared.problem.clearance.item_to_item) {
        let existing = &state.placed[index];
        if shared_rotation
            && existing.placement.item_id == variant.item_id
            && angular_distance(existing.placement.rotation_deg, variant.rotation_deg) > EPSILON
        {
            metrics.collision_check_ms += metric_elapsed_ms(collision_started);
            return None;
        }
        if !candidate
            .bounds
            .overlaps(existing.bounds, prepared.problem.clearance.item_to_item)
        {
            metrics.broad_phase_rejections += 1;
            continue;
        }
        metrics.exact_geometry_checks += 1;
        if sets_overlap(&geometry, &existing.geometry)
            || set_distance(&geometry, &existing.geometry) + EPSILON
                < prepared.problem.clearance.item_to_item
        {
            metrics.collision_check_ms += metric_elapsed_ms(collision_started);
            return None;
        }
    }
    metrics.collision_check_ms += metric_elapsed_ms(collision_started);
    metrics.valid_candidates += 1;
    Some(Placed {
        placement: Placement {
            item_id: variant.item_id.clone(),
            x: candidate.x,
            y: candidate.y,
            rotation_deg: variant.rotation_deg,
            fixed: false,
        },
        variant_id: variant.id,
        geometry,
        bounds: candidate.bounds,
    })
}

struct SpatialIndex {
    cell_size: f64,
    cells: BTreeMap<(i64, i64), Vec<usize>>,
}

impl SpatialIndex {
    fn new(state: &SearchState, cell_size: f64) -> Self {
        let cell_size = cell_size.max(1e-6);
        let mut cells = BTreeMap::new();
        for (index, placed) in state.placed.iter().enumerate() {
            for key in cell_keys(placed.bounds, 0.0, cell_size) {
                cells.entry(key).or_insert_with(Vec::new).push(index);
            }
        }
        Self { cell_size, cells }
    }

    fn query(&self, bounds: Bounds, gap: f64) -> Vec<usize> {
        let mut found = BTreeSet::new();
        for key in cell_keys(bounds, gap, self.cell_size) {
            if let Some(indexes) = self.cells.get(&key) {
                found.extend(indexes.iter().copied());
            }
        }
        found.into_iter().collect()
    }
}

fn cell_keys(bounds: Bounds, gap: f64, cell_size: f64) -> Vec<(i64, i64)> {
    let min_x = ((bounds.min_x - gap) / cell_size).floor() as i64;
    let max_x = ((bounds.max_x + gap) / cell_size).floor() as i64;
    let min_y = ((bounds.min_y - gap) / cell_size).floor() as i64;
    let max_y = ((bounds.max_y + gap) / cell_size).floor() as i64;
    let mut keys = Vec::new();
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            keys.push((x, y));
        }
    }
    keys
}

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

fn contact_points(set: &PolygonSet, limit: usize) -> Vec<crate::Point> {
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

fn angular_distance(a: f64, b: f64) -> f64 {
    (a - b).rem_euclid(360.0).min((b - a).rem_euclid(360.0))
}

// The finite graph uses candidates generated without item contacts. It is deliberately bounded:
// graph optimality, when reported, applies only to this candidate set.
fn conflict_graph_refine(
    prepared: &PreparedProblem,
    config: &SearchConfig,
    incumbent: &SearchState,
    metrics: &mut SearchMetrics,
    observer: &mut dyn SolveObserver,
) -> Option<SearchState> {
    let empty = SearchState::from_placed(
        prepared,
        incumbent
            .placed
            .iter()
            .filter(|p| p.placement.fixed)
            .cloned()
            .collect(),
    );
    let mut candidates = generate_candidates(prepared, &empty, config, metrics, observer)?;
    score_candidates(prepared, &empty, &mut candidates, metrics);
    candidates.truncate(96);
    let spatial = SpatialIndex::new(
        &empty,
        prepared.minimum_item_area.sqrt().max(config.grid_stride),
    );
    let mut feasible = candidates
        .into_iter()
        .filter_map(|candidate| feasible_candidate(prepared, &empty, &spatial, &candidate, metrics))
        .collect::<Vec<_>>();
    metrics.conflict_graph_candidates = feasible.len();
    if feasible.is_empty() {
        metrics.conflict_graph_status = ConflictGraphStatus::BestFound;
        return None;
    }
    let mut adjacency = vec![0_u128; feasible.len()];
    for first in 0..feasible.len() {
        if observer.should_cancel() {
            metrics.cancelled = true;
            return None;
        }
        for second in (first + 1)..feasible.len() {
            if placements_conflict(prepared, &feasible[first], &feasible[second]) {
                adjacency[first] |= 1_u128 << second;
                adjacency[second] |= 1_u128 << first;
            }
        }
    }
    let mut order = (0..feasible.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        adjacency[*b]
            .count_ones()
            .cmp(&adjacency[*a].count_ones())
            .then_with(|| a.cmp(b))
    });
    let reordered = order
        .iter()
        .map(|index| feasible[*index].clone())
        .collect::<Vec<_>>();
    let mut reordered_adjacency = vec![0_u128; feasible.len()];
    for (new_first, old_first) in order.iter().enumerate() {
        for (new_second, old_second) in order.iter().enumerate() {
            if adjacency[*old_first] & (1_u128 << old_second) != 0 {
                reordered_adjacency[new_first] |= 1_u128 << new_second;
            }
        }
    }
    feasible = reordered;

    let mut selected = empty.placed.clone();
    let mut counts = empty.counts.clone();
    let mut greedy_mask = 0_u128;
    for (index, node) in feasible.iter().enumerate() {
        let variant = &prepared.variants[node.variant_id];
        if counts[variant.item_index] >= prepared.problem.items[variant.item_index].quantity {
            continue;
        }
        if reordered_adjacency[index] & greedy_mask == 0 {
            selected.push(node.clone());
            counts[variant.item_index] += 1;
            greedy_mask |= 1_u128 << index;
        }
    }
    let fixed_count = empty.placed.len();
    let mut best_mask = greedy_mask;
    let mut best_count = selected.len() - fixed_count;
    let mut budget = (config.max_states / 4).clamp(256, 30_000);
    let mut search_counts = empty.counts.clone();
    let complete = graph_branch_and_bound(
        prepared,
        &feasible,
        &reordered_adjacency,
        0,
        0,
        &mut search_counts,
        &mut best_mask,
        &mut best_count,
        &mut budget,
        observer,
    );
    if !complete && observer.should_cancel() {
        metrics.cancelled = true;
    }
    metrics.conflict_graph_status = if complete {
        ConflictGraphStatus::CandidateSetOptimal
    } else {
        ConflictGraphStatus::LimitReached
    };
    let mut graph_placements = empty.placed;
    for (index, node) in feasible.into_iter().enumerate() {
        if best_mask & (1_u128 << index) != 0 {
            graph_placements.push(node);
        }
    }
    Some(SearchState::from_placed(prepared, graph_placements))
}

fn placements_conflict(prepared: &PreparedProblem, first: &Placed, second: &Placed) -> bool {
    let first_variant = &prepared.variants[first.variant_id];
    let second_variant = &prepared.variants[second.variant_id];
    if first_variant.item_index == second_variant.item_index {
        let item = &prepared.problem.items[first_variant.item_index];
        let shared = matches!(
            item.rotation_policy,
            crate::RotationPolicy::Discrete {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            } | crate::RotationPolicy::Continuous {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            }
        );
        if shared
            && angular_distance(first.placement.rotation_deg, second.placement.rotation_deg)
                > EPSILON
        {
            return true;
        }
    }
    let gap = prepared.problem.clearance.item_to_item;
    first.bounds.overlaps(second.bounds, gap)
        && (sets_overlap(&first.geometry, &second.geometry)
            || set_distance(&first.geometry, &second.geometry) + EPSILON < gap)
}

#[allow(clippy::too_many_arguments)]
fn graph_branch_and_bound(
    prepared: &PreparedProblem,
    nodes: &[Placed],
    adjacency: &[u128],
    index: usize,
    selected_mask: u128,
    counts: &mut [u32],
    best_mask: &mut u128,
    best_count: &mut usize,
    budget: &mut u64,
    observer: &mut dyn SolveObserver,
) -> bool {
    if *budget == 0 {
        return false;
    }
    if budget.is_multiple_of(256) && observer.should_cancel() {
        return false;
    }
    *budget -= 1;
    let selected_count = selected_mask.count_ones() as usize;
    let mut future_by_item = vec![0usize; prepared.problem.items.len()];
    for node in &nodes[index..] {
        future_by_item[prepared.variants[node.variant_id].item_index] += 1;
    }
    let remaining_quantity_bound = future_by_item
        .into_iter()
        .enumerate()
        .map(|(item_index, future)| {
            future.min(
                (prepared.problem.items[item_index].quantity as usize)
                    .saturating_sub(counts[item_index] as usize),
            )
        })
        .sum::<usize>();
    if selected_count + remaining_quantity_bound <= *best_count {
        return true;
    }
    if index == nodes.len() {
        if selected_count > *best_count {
            *best_count = selected_count;
            *best_mask = selected_mask;
        }
        return true;
    }
    let node = &nodes[index];
    let variant = &prepared.variants[node.variant_id];
    if adjacency[index] & selected_mask == 0
        && counts[variant.item_index] < prepared.problem.items[variant.item_index].quantity
    {
        counts[variant.item_index] += 1;
        let include_complete = graph_branch_and_bound(
            prepared,
            nodes,
            adjacency,
            index + 1,
            selected_mask | (1_u128 << index),
            counts,
            best_mask,
            best_count,
            budget,
            observer,
        );
        counts[variant.item_index] -= 1;
        if !include_complete {
            return false;
        }
    }
    graph_branch_and_bound(
        prepared,
        nodes,
        adjacency,
        index + 1,
        selected_mask,
        counts,
        best_mask,
        best_count,
        budget,
        observer,
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn metric_clock_start() -> Instant {
    Instant::now()
}
#[cfg(target_arch = "wasm32")]
fn metric_clock_start() {}
#[cfg(not(target_arch = "wasm32"))]
fn metric_elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}
#[cfg(target_arch = "wasm32")]
fn metric_elapsed_ms(_: ()) -> u64 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
fn time_limit_reached(options: &SolveOptions, started: Instant) -> bool {
    !options.deterministic
        && options
            .time_limit_ms
            .is_some_and(|limit| metric_elapsed_ms(started) >= limit)
}

#[cfg(target_arch = "wasm32")]
fn time_limit_reached(_: &SolveOptions, _: ()) -> bool {
    false
}
