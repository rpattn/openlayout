use crate::clock::Clock;
use crate::geometry::{
    Bounds, EPSILON, PolygonSet, bounds, set_distance, set_inside, sets_overlap, transform,
};
use crate::numeric::{angular_distance, same_rotation};
use crate::prepare::PreparedVariant;
use crate::solver::SolveObserver;
use crate::{
    Placement, PreparedProblem, RotationCoupling, RotationPolicy, SolveOptions, SolveQuality,
};

#[derive(Debug, Default, Clone)]
pub(crate) struct OverlapRepairMetrics {
    pub attempts: u64,
    pub evaluated_moves: u64,
    pub accepted_moves: u64,
    pub weight_updates: u64,
    pub exact_geometry_checks: u64,
    pub successful_repairs: u64,
    pub best_penalty: Option<f64>,
    pub cancelled: bool,
    pub limit_reached: bool,
}

pub(crate) struct OverlapRepairOutcome {
    pub placements: Option<Vec<Placement>>,
    pub metrics: OverlapRepairMetrics,
}

#[derive(Clone)]
struct RepairPiece {
    placement: Placement,
    variant_id: usize,
    geometry: PolygonSet,
    bounds: Bounds,
}

#[derive(Clone)]
struct RepairState {
    pieces: Vec<RepairPiece>,
    weights: Vec<f64>,
    original_penalty: f64,
    weighted_penalty: f64,
}

pub(crate) fn repair_one_more(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    incumbent: &[Placement],
    failed_constructive_candidates: &[Placement],
    observer: &mut dyn SolveObserver,
) -> OverlapRepairOutcome {
    let mut metrics = OverlapRepairMetrics::default();
    let started = Clock::start();
    if options.quality == SolveQuality::Fast
        || incumbent.is_empty()
        || incumbent.len() >= total_requested(prepared)
        || prepared
            .simple_upper_bound
            .is_some_and(|upper| incumbent.len() >= upper)
        || !repair_complexity_allowed(prepared, options.quality, incumbent.len() + 1)
    {
        return OverlapRepairOutcome {
            placements: None,
            metrics,
        };
    }

    let Some(base) = state_from_placements(prepared, incumbent) else {
        return OverlapRepairOutcome {
            placements: None,
            metrics,
        };
    };
    let mut seeds = seed_states(
        prepared,
        &base,
        failed_constructive_candidates,
        &mut metrics,
    );
    let seed_limit = match options.quality {
        SolveQuality::Fast => 0,
        SolveQuality::Balanced => 3,
        SolveQuality::Thorough => 6,
    };
    seeds.sort_by(|a, b| {
        a.original_penalty
            .total_cmp(&b.original_penalty)
            .then_with(|| state_key(a).cmp(&state_key(b)))
    });
    seeds.dedup_by(|a, b| state_key(a) == state_key(b));
    seeds.truncate(seed_limit);

    let total_budget = repair_budget(options);
    let seed_count = seeds.len();
    let mut best_repaired = None;
    for (seed_index, mut state) in seeds.into_iter().enumerate() {
        if repair_time_limit_reached(options, started) {
            metrics.limit_reached = true;
            break;
        }
        if observer.should_cancel() {
            metrics.cancelled = true;
            break;
        }
        metrics.attempts += 1;
        update_best_penalty(&mut metrics, state.original_penalty);
        if state.original_penalty <= EPSILON && independently_valid(prepared, &state) {
            metrics.successful_repairs += 1;
            best_repaired = Some(
                state
                    .pieces
                    .into_iter()
                    .map(|piece| piece.placement)
                    .collect(),
            );
            break;
        }
        let attempts_left = (seed_count.saturating_sub(seed_index)).max(1) as u64;
        let used = metrics.evaluated_moves;
        let attempt_budget = total_budget
            .saturating_sub(used)
            .div_ceil(attempts_left)
            .max(1);
        minimize_overlap(
            prepared,
            options,
            &mut state,
            used + attempt_budget,
            &mut metrics,
            observer,
            started,
        );
        update_best_penalty(&mut metrics, state.original_penalty);
        if state.original_penalty <= EPSILON && independently_valid(prepared, &state) {
            metrics.successful_repairs += 1;
            best_repaired = Some(
                state
                    .pieces
                    .into_iter()
                    .map(|piece| piece.placement)
                    .collect(),
            );
            break;
        }
        if metrics.evaluated_moves >= total_budget || metrics.cancelled {
            break;
        }
    }

    OverlapRepairOutcome {
        placements: best_repaired,
        metrics,
    }
}

fn repair_complexity_allowed(
    prepared: &PreparedProblem,
    quality: SolveQuality,
    target_count: usize,
) -> bool {
    let piece_limit = match quality {
        SolveQuality::Fast => 0,
        SolveQuality::Balanced => 28,
        SolveQuality::Thorough => 48,
    };
    target_count <= piece_limit
        && prepared.variants.iter().all(|variant| {
            variant
                .geometry
                .polygons
                .iter()
                .map(Vec::len)
                .sum::<usize>()
                <= 24
        })
}

fn repair_budget(options: &SolveOptions) -> u64 {
    match options.quality {
        SolveQuality::Fast => 0,
        SolveQuality::Balanced => (options.max_iterations / 12).clamp(192, 2_000),
        SolveQuality::Thorough => (options.max_iterations / 6).clamp(512, 8_000),
    }
}

fn total_requested(prepared: &PreparedProblem) -> usize {
    prepared
        .problem
        .items
        .iter()
        .map(|item| item.quantity as usize)
        .sum()
}

fn state_from_placements(
    prepared: &PreparedProblem,
    placements: &[Placement],
) -> Option<RepairState> {
    let pieces = placements
        .iter()
        .map(|placement| {
            let variant = prepared.variants.iter().find(|variant| {
                variant.item_id == placement.item_id
                    && same_rotation(variant.rotation_deg, placement.rotation_deg)
            })?;
            Some(piece(variant, placement.x, placement.y, placement.fixed))
        })
        .collect::<Option<Vec<_>>>()?;
    let count = pieces.len();
    Some(RepairState {
        pieces,
        weights: vec![1.0; count * count],
        original_penalty: 0.0,
        weighted_penalty: 0.0,
    })
}

fn seed_states(
    prepared: &PreparedProblem,
    base: &RepairState,
    failed_constructive_candidates: &[Placement],
    metrics: &mut OverlapRepairMetrics,
) -> Vec<RepairState> {
    let mut counts = vec![0usize; prepared.problem.items.len()];
    for piece in &base.pieces {
        counts[prepared.variants[piece.variant_id].item_index] += 1;
    }
    let mut seeds = Vec::new();
    for failed in failed_constructive_candidates {
        let Some(variant) = prepared.variants.iter().find(|variant| {
            variant.item_id == failed.item_id
                && same_rotation(variant.rotation_deg, failed.rotation_deg)
        }) else {
            continue;
        };
        if counts[variant.item_index]
            >= prepared.problem.items[variant.item_index].quantity as usize
        {
            continue;
        }
        let extra = piece(variant, failed.x, failed.y, false);
        if hard_valid(prepared, &extra, base, metrics) {
            seeds.push(state_with_extra(prepared, base, extra, metrics));
        }
    }
    for (item_index, item) in prepared.problem.items.iter().enumerate() {
        if counts[item_index] >= item.quantity as usize {
            continue;
        }
        let Some(variant_ids) = prepared.variants_by_item.get(&item.id) else {
            continue;
        };
        let shared_angle = shared_angle(item, &base.pieces);
        let variants = variant_ids
            .iter()
            .filter(|variant_id| {
                shared_angle.is_none_or(|angle| {
                    same_rotation(prepared.variants[**variant_id].rotation_deg, angle)
                })
            })
            .take(4)
            .copied()
            .collect::<Vec<_>>();
        for variant_id in variants {
            let variant = &prepared.variants[variant_id];
            let mut anchors = base
                .pieces
                .iter()
                .filter(|entry| entry.placement.item_id == item.id)
                .map(|entry| (entry.placement.x, entry.placement.y))
                .collect::<Vec<_>>();
            anchors.extend(base.pieces.iter().map(|entry| {
                (
                    (entry.bounds.min_x + entry.bounds.max_x) / 2.0,
                    (entry.bounds.min_y + entry.bounds.max_y) / 2.0,
                )
            }));
            anchors.push((
                (prepared.container_bounds.min_x + prepared.container_bounds.max_x) / 2.0,
                (prepared.container_bounds.min_y + prepared.container_bounds.max_y) / 2.0,
            ));
            anchors.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.total_cmp(&b.0)));
            anchors.dedup_by(|a, b| (a.0 - b.0).abs() <= EPSILON && (a.1 - b.1).abs() <= EPSILON);
            anchors.truncate(16);
            for (x, y) in anchors {
                let extra = piece(variant, x, y, false);
                if !hard_valid(prepared, &extra, base, metrics) {
                    continue;
                }
                seeds.push(state_with_extra(prepared, base, extra, metrics));
            }
        }
    }
    seeds
}

fn state_with_extra(
    prepared: &PreparedProblem,
    base: &RepairState,
    extra: RepairPiece,
    metrics: &mut OverlapRepairMetrics,
) -> RepairState {
    let mut state = base.clone();
    state.pieces.push(extra);
    let count = state.pieces.len();
    state.weights = vec![1.0; count * count];
    let (original, weighted) = state_penalties(prepared, &state, metrics);
    state.original_penalty = original;
    state.weighted_penalty = weighted;
    state
}

fn minimize_overlap(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    state: &mut RepairState,
    evaluation_limit: u64,
    metrics: &mut OverlapRepairMetrics,
    observer: &mut dyn SolveObserver,
    started: Clock,
) {
    let max_weight_rounds = match options.quality {
        SolveQuality::Fast => 0,
        SolveQuality::Balanced => 5,
        SolveQuality::Thorough => 16,
    };
    let mut best = state.clone();
    let mut active = vec![true; state.pieces.len()];
    let start_index = (options.seed as usize) % state.pieces.len();
    for _ in 0..max_weight_rounds {
        loop {
            let mut moved = false;
            for offset in 0..state.pieces.len() {
                if metrics.evaluated_moves >= evaluation_limit {
                    *state = best;
                    return;
                }
                if repair_time_limit_reached(options, started) {
                    metrics.limit_reached = true;
                    *state = best;
                    return;
                }
                if metrics.evaluated_moves.is_multiple_of(128) && observer.should_cancel() {
                    metrics.cancelled = true;
                    *state = best;
                    return;
                }
                let index = (start_index + offset) % state.pieces.len();
                if !active[index] || state.pieces[index].placement.fixed {
                    continue;
                }
                active[index] = false;
                let before_conflicts = conflicting_neighbours(prepared, state, index, metrics);
                let Some((replacement, replacement_penalty)) =
                    best_piece_move(prepared, options, state, index, evaluation_limit, metrics)
                else {
                    continue;
                };
                let current_penalty =
                    piece_weighted_penalty(prepared, state, index, &state.pieces[index], metrics);
                if replacement_penalty + EPSILON >= current_penalty {
                    continue;
                }
                state.pieces[index] = replacement;
                let (original, weighted) = state_penalties(prepared, state, metrics);
                state.original_penalty = original;
                state.weighted_penalty = weighted;
                metrics.accepted_moves += 1;
                moved = true;
                let after_conflicts = conflicting_neighbours(prepared, state, index, metrics);
                active[index] = true;
                for neighbour in before_conflicts.into_iter().chain(after_conflicts) {
                    active[neighbour] = true;
                }
                if state.original_penalty + EPSILON < best.original_penalty {
                    best = state.clone();
                    update_best_penalty(metrics, best.original_penalty);
                }
                if state.original_penalty <= EPSILON {
                    return;
                }
                break;
            }
            if !moved {
                break;
            }
        }
        if state.original_penalty <= EPSILON || metrics.evaluated_moves >= evaluation_limit {
            break;
        }
        let conflicts = conflict_penalties(prepared, state, metrics);
        let maximum = conflicts
            .iter()
            .map(|(_, _, penalty)| *penalty)
            .fold(0.0, f64::max);
        if maximum <= EPSILON {
            break;
        }
        for (first, second, penalty) in conflicts {
            let count = state.pieces.len();
            let increment = penalty / maximum;
            state.weights[first * count + second] += increment;
            state.weights[second * count + first] += increment;
            metrics.weight_updates += 1;
            active[first] = true;
            active[second] = true;
        }
        let (original, weighted) = state_penalties(prepared, state, metrics);
        state.original_penalty = original;
        state.weighted_penalty = weighted;
    }
    if best.original_penalty + EPSILON < state.original_penalty {
        *state = best;
    }
}

fn best_piece_move(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    state: &RepairState,
    index: usize,
    evaluation_limit: u64,
    metrics: &mut OverlapRepairMetrics,
) -> Option<(RepairPiece, f64)> {
    let original = &state.pieces[index];
    let variant_ids = allowed_variants(prepared, state, index);
    let mut best = original.clone();
    let mut best_penalty = piece_weighted_penalty(prepared, state, index, original, metrics);
    let mut best_distance = 0.0;
    for variant_id in variant_ids.into_iter().take(12) {
        if metrics.evaluated_moves >= evaluation_limit {
            break;
        }
        let variant = &prepared.variants[variant_id];
        let mut current = piece(variant, original.placement.x, original.placement.y, false);
        if !hard_valid(prepared, &current, state, metrics) {
            continue;
        }
        for axis in [Axis::Horizontal, Axis::Vertical, Axis::Horizontal] {
            let positions =
                line_positions(prepared, state, index, variant, &current, axis, options);
            let mut axis_best = current.clone();
            let mut axis_penalty =
                piece_weighted_penalty(prepared, state, index, &axis_best, metrics);
            let mut axis_distance = piece_distance(&axis_best, original);
            for coordinate in positions {
                if metrics.evaluated_moves >= evaluation_limit {
                    break;
                }
                let trial = match axis {
                    Axis::Horizontal => piece(variant, coordinate, current.placement.y, false),
                    Axis::Vertical => piece(variant, current.placement.x, coordinate, false),
                };
                metrics.evaluated_moves += 1;
                if !hard_valid(prepared, &trial, state, metrics) {
                    continue;
                }
                let penalty = piece_weighted_penalty(prepared, state, index, &trial, metrics);
                let distance = piece_distance(&trial, original);
                if penalty + EPSILON < axis_penalty
                    || ((penalty - axis_penalty).abs() <= EPSILON
                        && (distance + EPSILON < axis_distance
                            || ((distance - axis_distance).abs() <= EPSILON
                                && placement_key(&trial) < placement_key(&axis_best))))
                {
                    axis_best = trial;
                    axis_penalty = penalty;
                    axis_distance = distance;
                }
            }
            current = axis_best;
        }
        let penalty = piece_weighted_penalty(prepared, state, index, &current, metrics);
        let distance = piece_distance(&current, original);
        if penalty + EPSILON < best_penalty
            || ((penalty - best_penalty).abs() <= EPSILON
                && (distance + EPSILON < best_distance
                    || ((distance - best_distance).abs() <= EPSILON
                        && placement_key(&current) < placement_key(&best))))
        {
            best = current;
            best_penalty = penalty;
            best_distance = distance;
        }
    }
    Some((best, best_penalty))
}

#[derive(Clone, Copy)]
enum Axis {
    Horizontal,
    Vertical,
}

fn line_positions(
    prepared: &PreparedProblem,
    state: &RepairState,
    moving_index: usize,
    variant: &PreparedVariant,
    current: &RepairPiece,
    axis: Axis,
    options: &SolveOptions,
) -> Vec<f64> {
    let boundary = prepared.problem.clearance.item_to_boundary;
    let pair_gap = prepared.problem.clearance.item_to_item + EPSILON * 10.0;
    let (minimum, maximum, local_min, local_max, current_coordinate) = match axis {
        Axis::Horizontal => (
            prepared.container_bounds.min_x + boundary - variant.bounds.min_x,
            prepared.container_bounds.max_x - boundary - variant.bounds.max_x,
            variant.bounds.min_x,
            variant.bounds.max_x,
            current.placement.x,
        ),
        Axis::Vertical => (
            prepared.container_bounds.min_y + boundary - variant.bounds.min_y,
            prepared.container_bounds.max_y - boundary - variant.bounds.max_y,
            variant.bounds.min_y,
            variant.bounds.max_y,
            current.placement.y,
        ),
    };
    let mut positions = vec![minimum, maximum, current_coordinate];
    let step = options.grid_step.max((maximum - minimum).abs() / 24.0);
    positions.extend([
        current_coordinate - step,
        current_coordinate + step,
        current_coordinate - 2.0 * step,
        current_coordinate + 2.0 * step,
    ]);
    for (index, other) in state.pieces.iter().enumerate() {
        if index == moving_index {
            continue;
        }
        let (other_min, other_max, other_coordinate) = match axis {
            Axis::Horizontal => (other.bounds.min_x, other.bounds.max_x, other.placement.x),
            Axis::Vertical => (other.bounds.min_y, other.bounds.max_y, other.placement.y),
        };
        positions.extend([
            other_min - pair_gap - local_max,
            other_max + pair_gap - local_min,
            other_coordinate,
        ]);
    }
    if maximum > minimum + EPSILON {
        for sample in 0..=12 {
            positions.push(minimum + (maximum - minimum) * sample as f64 / 12.0);
        }
    }
    positions.retain(|value| {
        value.is_finite() && *value >= minimum - EPSILON && *value <= maximum + EPSILON
    });
    positions.sort_by(f64::total_cmp);
    positions.dedup_by(|a, b| (*a - *b).abs() <= EPSILON);
    positions
}

fn allowed_variants(
    prepared: &PreparedProblem,
    state: &RepairState,
    moving_index: usize,
) -> Vec<usize> {
    let moving = &state.pieces[moving_index];
    let item = &prepared.problem.items[prepared.variants[moving.variant_id].item_index];
    let shared = shared_angle_excluding(item, &state.pieces, moving_index);
    let mut variants = prepared
        .variants_by_item
        .get(&moving.placement.item_id)
        .into_iter()
        .flatten()
        .filter(|variant_id| {
            shared.is_none_or(|angle| {
                same_rotation(prepared.variants[**variant_id].rotation_deg, angle)
            })
        })
        .copied()
        .collect::<Vec<_>>();
    variants.sort_by(|a, b| {
        (!same_rotation(
            prepared.variants[*a].rotation_deg,
            moving.placement.rotation_deg,
        ))
        .cmp(
            &(!same_rotation(
                prepared.variants[*b].rotation_deg,
                moving.placement.rotation_deg,
            )),
        )
        .then_with(|| {
            prepared.variants[*a]
                .rotation_deg
                .total_cmp(&prepared.variants[*b].rotation_deg)
        })
    });
    variants
}

fn shared_angle(item: &crate::Item, pieces: &[RepairPiece]) -> Option<f64> {
    matches!(
        item.rotation_policy,
        RotationPolicy::Discrete {
            coupling: RotationCoupling::SharedPerItem,
            ..
        } | RotationPolicy::Continuous {
            coupling: RotationCoupling::SharedPerItem,
            ..
        }
    )
    .then(|| {
        pieces
            .iter()
            .find(|piece| piece.placement.item_id == item.id)
            .map(|piece| piece.placement.rotation_deg)
    })
    .flatten()
}

fn shared_angle_excluding(
    item: &crate::Item,
    pieces: &[RepairPiece],
    excluded: usize,
) -> Option<f64> {
    matches!(
        item.rotation_policy,
        RotationPolicy::Discrete {
            coupling: RotationCoupling::SharedPerItem,
            ..
        } | RotationPolicy::Continuous {
            coupling: RotationCoupling::SharedPerItem,
            ..
        }
    )
    .then(|| {
        pieces
            .iter()
            .enumerate()
            .find(|(index, piece)| *index != excluded && piece.placement.item_id == item.id)
            .map(|(_, piece)| piece.placement.rotation_deg)
    })
    .flatten()
}

fn hard_valid(
    prepared: &PreparedProblem,
    candidate: &RepairPiece,
    state: &RepairState,
    metrics: &mut OverlapRepairMetrics,
) -> bool {
    metrics.exact_geometry_checks += 1;
    if !set_inside(
        &candidate.geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    ) {
        return false;
    }
    for (index, exclusion) in prepared.exclusions.iter().enumerate() {
        let required = prepared
            .problem
            .clearance
            .item_to_exclusion
            .max(prepared.problem.exclusions[index].clearance);
        if !candidate.bounds.overlaps(bounds(exclusion), required) {
            continue;
        }
        metrics.exact_geometry_checks += 1;
        if sets_overlap(&candidate.geometry, exclusion)
            || set_distance(&candidate.geometry, exclusion) + EPSILON < required
        {
            return false;
        }
    }
    let item = &prepared.problem.items[prepared.variants[candidate.variant_id].item_index];
    if let Some(angle) = shared_angle(item, &state.pieces)
        && !same_rotation(angle, candidate.placement.rotation_deg)
    {
        return false;
    }
    true
}

mod penalty;
#[cfg(test)]
use penalty::pair_penalty;
use penalty::{
    conflict_penalties, conflicting_neighbours, piece_weighted_penalty, state_penalties,
};

fn independently_valid(prepared: &PreparedProblem, state: &RepairState) -> bool {
    crate::validate_placements(
        prepared,
        &state
            .pieces
            .iter()
            .map(|piece| piece.placement.clone())
            .collect::<Vec<_>>(),
    )
    .is_ok_and(|report| report.valid)
}

fn piece(variant: &PreparedVariant, x: f64, y: f64, fixed: bool) -> RepairPiece {
    RepairPiece {
        placement: Placement {
            item_id: variant.item_id.clone(),
            x,
            y,
            rotation_deg: variant.rotation_deg,
            fixed,
        },
        variant_id: variant.id,
        geometry: transform(&variant.geometry, 0.0, x, y),
        bounds: variant.bounds.translated(x, y),
    }
}

fn piece_distance(candidate: &RepairPiece, original: &RepairPiece) -> f64 {
    (candidate.placement.x - original.placement.x).abs()
        + (candidate.placement.y - original.placement.y).abs()
        + angular_distance(
            candidate.placement.rotation_deg,
            original.placement.rotation_deg,
        ) / 360.0
}

fn placement_key(piece: &RepairPiece) -> (usize, u64, u64) {
    (
        piece.variant_id,
        piece.placement.x.to_bits(),
        piece.placement.y.to_bits(),
    )
}

fn state_key(state: &RepairState) -> Vec<(usize, u64, u64)> {
    let mut key = state.pieces.iter().map(placement_key).collect::<Vec<_>>();
    key.sort();
    key
}

fn update_best_penalty(metrics: &mut OverlapRepairMetrics, penalty: f64) {
    if metrics
        .best_penalty
        .is_none_or(|best| penalty + EPSILON < best)
    {
        metrics.best_penalty = Some(penalty);
    }
}

fn repair_time_limit_reached(options: &SolveOptions, started: Clock) -> bool {
    !options.deterministic
        && options
            .time_limit_ms
            .is_some_and(|limit| started.elapsed_ms() >= limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Clearance, Container, Item, PackingProblem, Point, RegionOperation, RegionPart, Shape,
        prepare_problem,
    };

    struct Observer;
    impl SolveObserver for Observer {}

    fn rectangle_problem() -> PreparedProblem {
        prepare_problem(&PackingProblem {
            schema_version: 2,
            container: Container {
                parts: vec![RegionPart {
                    id: "stock".into(),
                    operation: RegionOperation::Add,
                    shape: Shape::Rectangle {
                        width: 10.0,
                        height: 10.0,
                    },
                    translation: Point::default(),
                    rotation_deg: 0.0,
                    snap: None,
                }],
            },
            exclusions: Vec::new(),
            items: vec![Item {
                id: "item-a".into(),
                shape: Shape::Rectangle {
                    width: 2.0,
                    height: 2.0,
                },
                quantity: 2,
                rotation_policy: RotationPolicy::Discrete {
                    angles_deg: vec![0.0],
                    coupling: RotationCoupling::Independent,
                },
            }],
            fixed_placements: Vec::new(),
            clearance: Clearance::default(),
        })
        .unwrap()
    }

    #[test]
    fn directional_penalty_and_guided_weights_track_unresolved_conflicts() {
        let prepared = rectangle_problem();
        let variant = &prepared.variants[0];
        let first = piece(variant, 0.0, 0.0, true);
        let second = piece(variant, 0.5, 0.0, true);
        let separated = piece(variant, 3.0, 0.0, true);
        let mut metrics = OverlapRepairMetrics::default();

        let overlap = pair_penalty(&first, &second, 0.0, &mut metrics);
        assert!(overlap > 1.49 && overlap < 1.51);
        assert_eq!(pair_penalty(&first, &separated, 0.0, &mut metrics), 0.0);

        let mut state = RepairState {
            pieces: vec![first, second],
            weights: vec![1.0; 4],
            original_penalty: overlap,
            weighted_penalty: overlap,
        };
        let options = SolveOptions {
            max_iterations: 100,
            ..SolveOptions::default()
        };
        minimize_overlap(
            &prepared,
            &options,
            &mut state,
            100,
            &mut metrics,
            &mut Observer,
            Clock::start(),
        );

        assert!(metrics.weight_updates > 0);
        assert!(state.weighted_penalty > state.original_penalty);
        assert_eq!(state.original_penalty, overlap);
    }
}
