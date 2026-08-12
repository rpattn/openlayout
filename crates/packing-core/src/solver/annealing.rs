use super::*;

pub(super) fn anneal_elongated_continuation(
    prepared: &PreparedProblem,
    placements: &[Placement],
    seed: u64,
    iterations: u64,
) -> Option<Vec<Placement>> {
    if placements.is_empty()
        || prepared.problem.items.len() != 1
        || !matches!(
            prepared.problem.items[0].rotation_policy,
            crate::RotationPolicy::Continuous {
                coupling: crate::RotationCoupling::Independent,
                ..
            }
        )
        || placements.len() > 28
        || placements.iter().any(|placement| placement.fixed)
    {
        return None;
    }
    let initial_state = placements
        .iter()
        .map(|placement| {
            let variant_id = prepared.variants.iter().position(|variant| {
                variant.item_id == placement.item_id
                    && same_rotation(variant.rotation_deg, placement.rotation_deg)
            })?;
            Some((
                candidate(
                    &prepared.variants[variant_id],
                    placement.x,
                    placement.y,
                    placement.fixed,
                ),
                variant_id,
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    let (mut state, mut state_variant_ids): (Vec<_>, Vec<_>) = initial_state.into_iter().unzip();
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let reference = &prepared.variants[prepared.variants_by_item[&placements[0].item_id][0]];
    let minor_half_extent = reference.bounds.width().min(reference.bounds.height()) / 2.0;
    // Slightly enlarge the cheap capsule surrogate so its zero-penalty states remain
    // conservative around the rectangular shoulders of a compound capsule.
    let radius = minor_half_extent * 1.005;
    if reference.bounds.width().max(reference.bounds.height()) < radius * 4.0
        || reference
            .geometry
            .polygons
            .iter()
            .map(Vec::len)
            .sum::<usize>()
            <= 16
    {
        return None;
    }
    let half_segment =
        reference.bounds.width().max(reference.bounds.height()) / 2.0 - minor_half_extent;
    let rectangular_core = largest_container_rectangle(prepared);
    let mut penalty = capsule_layout_penalty(prepared, &state, radius, half_segment);
    let mut best = state.clone();
    let mut best_penalty = penalty;
    for iteration in 0..iterations {
        let progress = iteration as f64 / iterations.max(1) as f64;
        let temperature = 1.5 * (1.0 - progress).powi(2) + 0.002;
        let step = 4.0 * (1.0 - progress) + 0.02;
        let index = rng.random_range(0..state.len());
        if state[index].placement.fixed {
            continue;
        }
        let original = state[index].clone();
        let variants = &prepared.variants_by_item[&original.placement.item_id];
        let variant_id = if rng.random::<f64>() < 0.05 {
            variants[rng.random_range(0..variants.len())]
        } else {
            state_variant_ids[index]
        };
        let variant = &prepared.variants[variant_id];
        let (x, y) = if rng.random::<f64>() < 0.02 {
            (
                rng.random_range(prepared.container_bounds.min_x..prepared.container_bounds.max_x),
                rng.random_range(prepared.container_bounds.min_y..prepared.container_bounds.max_y),
            )
        } else {
            (
                original.placement.x + rng.random_range(-step..step),
                original.placement.y + rng.random_range(-step..step),
            )
        };
        let trial = candidate(variant, x, y, false);
        if !anneal_hard_valid(prepared, rectangular_core, &trial) {
            continue;
        }
        let old_local =
            capsule_piece_penalty(prepared, &state, index, &original, radius, half_segment);
        let new_local =
            capsule_piece_penalty(prepared, &state, index, &trial, radius, half_segment);
        let delta = new_local - old_local;
        if delta <= 0.0 || rng.random::<f64>() < (-delta / temperature).exp() {
            state[index] = trial;
            state_variant_ids[index] = variant_id;
            penalty = (penalty + delta).max(0.0);
            if penalty <= EPSILON {
                let placements = state
                    .iter()
                    .map(|entry| entry.placement.clone())
                    .collect::<Vec<_>>();
                if validate_placements(prepared, &placements).is_ok_and(|report| report.valid) {
                    return Some(placements);
                }
            }
            if penalty + EPSILON < best_penalty {
                best = state.clone();
                best_penalty = capsule_layout_penalty(prepared, &best, radius, half_segment);
            }
        }
    }
    let placements = best
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    (best_penalty <= EPSILON
        && validate_placements(prepared, &placements).is_ok_and(|report| report.valid))
    .then_some(placements)
}

fn anneal_hard_valid(
    prepared: &PreparedProblem,
    rectangular_core: Option<Bounds>,
    candidate: &CandidatePlacement,
) -> bool {
    let boundary = prepared.problem.clearance.item_to_boundary;
    if candidate.bounds.min_x < prepared.container_bounds.min_x + boundary - EPSILON
        || candidate.bounds.max_x > prepared.container_bounds.max_x - boundary + EPSILON
        || candidate.bounds.min_y < prepared.container_bounds.min_y + boundary - EPSILON
        || candidate.bounds.max_y > prepared.container_bounds.max_y - boundary + EPSILON
    {
        return false;
    }
    // Most trials remain inside a large rectangular subset of the container. Pay for exact
    // containment only outside that precomputed safe region; final acceptance always uses the
    // independent validator.
    let inside_rectangular_core = rectangular_core.is_some_and(|core| {
        candidate.bounds.min_x >= core.min_x + boundary - EPSILON
            && candidate.bounds.max_x <= core.max_x - boundary + EPSILON
            && candidate.bounds.min_y >= core.min_y + boundary - EPSILON
            && candidate.bounds.max_y <= core.max_y - boundary + EPSILON
    });
    if !inside_rectangular_core && !set_inside(&candidate.geometry, &prepared.container, boundary) {
        return false;
    }
    prepared
        .exclusions
        .iter()
        .enumerate()
        .all(|(index, exclusion)| {
            let required = prepared
                .problem
                .clearance
                .item_to_exclusion
                .max(prepared.problem.exclusions[index].clearance);
            !candidate.bounds.overlaps(bounds(exclusion), required)
                || (!sets_overlap(&candidate.geometry, exclusion)
                    && set_distance(&candidate.geometry, exclusion) + EPSILON >= required)
        })
}

fn capsule_layout_penalty(
    prepared: &PreparedProblem,
    state: &[CandidatePlacement],
    radius: f64,
    half_segment: f64,
) -> f64 {
    let mut penalty = 0.0;
    for first in 0..state.len() {
        for second in (first + 1)..state.len() {
            penalty += capsule_pair_penalty(
                prepared,
                &state[first],
                &state[second],
                radius,
                half_segment,
            );
        }
    }
    penalty
}

fn capsule_piece_penalty(
    prepared: &PreparedProblem,
    state: &[CandidatePlacement],
    moving_index: usize,
    candidate: &CandidatePlacement,
    radius: f64,
    half_segment: f64,
) -> f64 {
    state
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != moving_index)
        .map(|(_, other)| capsule_pair_penalty(prepared, candidate, other, radius, half_segment))
        .sum()
}

fn capsule_pair_penalty(
    prepared: &PreparedProblem,
    first: &CandidatePlacement,
    second: &CandidatePlacement,
    radius: f64,
    half_segment: f64,
) -> f64 {
    let segment = |placement: &Placement| {
        let radians = placement.rotation_deg.to_radians();
        let dx = radians.cos() * half_segment;
        let dy = radians.sin() * half_segment;
        (
            crate::Point {
                x: placement.x - dx,
                y: placement.y - dy,
            },
            crate::Point {
                x: placement.x + dx,
                y: placement.y + dy,
            },
        )
    };
    let (first_a, first_b) = segment(&first.placement);
    let (second_a, second_b) = segment(&second.placement);
    (radius * 2.0 + prepared.problem.clearance.item_to_item
        - capsule_surrogate_segment_distance(first_a, first_b, second_a, second_b))
    .max(0.0)
}

/// Distance metric used only by the capsule annealing surrogate.
///
/// This deliberately retains the search lane's permissive epsilon product test. The exact
/// geometry kernel uses robust orientation/on-segment predicates and remains authoritative for
/// feasibility and final validation.
fn capsule_surrogate_segment_distance(
    first_a: crate::Point,
    first_b: crate::Point,
    second_a: crate::Point,
    second_b: crate::Point,
) -> f64 {
    if capsule_surrogate_segments_intersect(first_a, first_b, second_a, second_b) {
        return 0.0;
    }
    [
        capsule_surrogate_point_segment_distance(first_a, second_a, second_b),
        capsule_surrogate_point_segment_distance(first_b, second_a, second_b),
        capsule_surrogate_point_segment_distance(second_a, first_a, first_b),
        capsule_surrogate_point_segment_distance(second_b, first_a, first_b),
    ]
    .into_iter()
    .fold(f64::INFINITY, f64::min)
}

fn capsule_surrogate_segments_intersect(
    a: crate::Point,
    b: crate::Point,
    c: crate::Point,
    d: crate::Point,
) -> bool {
    let orientation = |p: crate::Point, q: crate::Point, r: crate::Point| {
        (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
    };
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    let bounds_overlap = a.x.min(b.x) <= c.x.max(d.x) + EPSILON
        && a.x.max(b.x) + EPSILON >= c.x.min(d.x)
        && a.y.min(b.y) <= c.y.max(d.y) + EPSILON
        && a.y.max(b.y) + EPSILON >= c.y.min(d.y);
    bounds_overlap && ab_c * ab_d <= EPSILON && cd_a * cd_b <= EPSILON
}

fn capsule_surrogate_point_segment_distance(
    point: crate::Point,
    start: crate::Point,
    end: crate::Point,
) -> f64 {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;
    if length_squared <= EPSILON * EPSILON {
        return (point.x - start.x).hypot(point.y - start.y);
    }
    let projection =
        (((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared).clamp(0.0, 1.0);
    (point.x - (start.x + projection * dx)).hypot(point.y - (start.y + projection * dy))
}
