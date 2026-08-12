use super::*;

pub(super) fn state_penalties(
    prepared: &PreparedProblem,
    state: &RepairState,
    metrics: &mut OverlapRepairMetrics,
) -> (f64, f64) {
    let mut original = 0.0;
    let mut weighted = 0.0;
    let count = state.pieces.len();
    for first in 0..count {
        for second in (first + 1)..count {
            let penalty = pair_penalty(
                &state.pieces[first],
                &state.pieces[second],
                prepared.problem.clearance.item_to_item,
                metrics,
            );
            original += penalty;
            weighted += state.weights[first * count + second] * penalty;
        }
    }
    (original, weighted)
}

pub(super) fn piece_weighted_penalty(
    prepared: &PreparedProblem,
    state: &RepairState,
    moving_index: usize,
    candidate: &RepairPiece,
    metrics: &mut OverlapRepairMetrics,
) -> f64 {
    let count = state.pieces.len();
    state
        .pieces
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != moving_index)
        .map(|(index, other)| {
            state.weights[moving_index * count + index]
                * pair_penalty(
                    candidate,
                    other,
                    prepared.problem.clearance.item_to_item,
                    metrics,
                )
        })
        .sum()
}

pub(super) fn pair_penalty(
    first: &RepairPiece,
    second: &RepairPiece,
    required: f64,
    metrics: &mut OverlapRepairMetrics,
) -> f64 {
    if !pieces_conflict(first, second, required, metrics) {
        return 0.0;
    }
    let epsilon_gap = required + EPSILON * 10.0;
    let directions = [
        (
            second.bounds.max_x + epsilon_gap - first.bounds.min_x,
            1.0,
            0.0,
        ),
        (
            first.bounds.max_x + epsilon_gap - second.bounds.min_x,
            -1.0,
            0.0,
        ),
        (
            second.bounds.max_y + epsilon_gap - first.bounds.min_y,
            0.0,
            1.0,
        ),
        (
            first.bounds.max_y + epsilon_gap - second.bounds.min_y,
            0.0,
            -1.0,
        ),
    ];
    directions
        .into_iter()
        .map(|(upper, dx, dy)| {
            directional_penetration(first, second, required, upper.max(EPSILON), dx, dy, metrics)
        })
        .fold(f64::INFINITY, f64::min)
}

fn directional_penetration(
    moving: &RepairPiece,
    fixed: &RepairPiece,
    required: f64,
    upper: f64,
    dx: f64,
    dy: f64,
    metrics: &mut OverlapRepairMetrics,
) -> f64 {
    let mut low = 0.0;
    let mut high = upper + EPSILON * 100.0;
    for _ in 0..14 {
        let middle = (low + high) / 2.0;
        let moved = RepairPiece {
            placement: Placement {
                x: moving.placement.x + dx * middle,
                y: moving.placement.y + dy * middle,
                ..moving.placement.clone()
            },
            variant_id: moving.variant_id,
            geometry: transform(&moving.geometry, 0.0, dx * middle, dy * middle),
            bounds: moving.bounds.translated(dx * middle, dy * middle),
        };
        if pieces_conflict(&moved, fixed, required, metrics) {
            low = middle;
        } else {
            high = middle;
        }
    }
    high
}

fn pieces_conflict(
    first: &RepairPiece,
    second: &RepairPiece,
    required: f64,
    metrics: &mut OverlapRepairMetrics,
) -> bool {
    if !first.bounds.overlaps(second.bounds, required) {
        return false;
    }
    metrics.exact_geometry_checks += 1;
    sets_conflict(&first.geometry, &second.geometry, required)
}

pub(super) fn conflicting_neighbours(
    prepared: &PreparedProblem,
    state: &RepairState,
    index: usize,
    metrics: &mut OverlapRepairMetrics,
) -> Vec<usize> {
    state
        .pieces
        .iter()
        .enumerate()
        .filter(|(other, _)| *other != index)
        .filter(|(_, piece)| {
            pieces_conflict(
                &state.pieces[index],
                piece,
                prepared.problem.clearance.item_to_item,
                metrics,
            )
        })
        .map(|(other, _)| other)
        .collect()
}

pub(super) fn conflict_penalties(
    prepared: &PreparedProblem,
    state: &RepairState,
    metrics: &mut OverlapRepairMetrics,
) -> Vec<(usize, usize, f64)> {
    let mut conflicts = Vec::new();
    for first in 0..state.pieces.len() {
        for second in (first + 1)..state.pieces.len() {
            let penalty = pair_penalty(
                &state.pieces[first],
                &state.pieces[second],
                prepared.problem.clearance.item_to_item,
                metrics,
            );
            if penalty > EPSILON {
                conflicts.push((first, second, penalty));
            }
        }
    }
    conflicts
}
