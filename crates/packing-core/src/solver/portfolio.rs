use super::*;

pub(super) fn portfolio_orders(
    prepared: &PreparedProblem,
    seed: u64,
    restarts: u32,
) -> Vec<(String, Vec<usize>, bool, bool, bool, bool)> {
    let mut output = Vec::new();
    let mut base: Vec<_> = (0..prepared.variants.len()).collect();
    base.sort_by(|a, b| {
        prepared.variants[*b]
            .bounds
            .width()
            .total_cmp(&prepared.variants[*a].bounds.width())
            .then_with(|| a.cmp(b))
    });
    output.push((
        "structured_rows".to_string(),
        base.clone(),
        false,
        false,
        false,
        false,
    ));
    output.push((
        "structured_staggered".to_string(),
        base.clone(),
        true,
        false,
        false,
        false,
    ));
    let mut by_height = base.clone();
    by_height.sort_by(|a, b| {
        prepared.variants[*b]
            .bounds
            .height()
            .total_cmp(&prepared.variants[*a].bounds.height())
            .then_with(|| a.cmp(b))
    });
    output.push((
        "structured_columns".to_string(),
        by_height.clone(),
        false,
        true,
        false,
        false,
    ));
    output.push((
        "structured_alternating".to_string(),
        base.clone(),
        false,
        false,
        true,
        false,
    ));
    output.push((
        "structured_rows_top".to_string(),
        base.clone(),
        false,
        false,
        false,
        true,
    ));
    output.push((
        "structured_staggered_top".to_string(),
        base.clone(),
        true,
        false,
        false,
        true,
    ));
    output.push((
        "structured_columns_right".to_string(),
        by_height.clone(),
        false,
        true,
        false,
        true,
    ));
    for restart in 0..restarts.saturating_sub(1) {
        let mut shuffled = base.clone();
        let mut rng = ChaCha8Rng::seed_from_u64(seed.wrapping_add(restart as u64).wrapping_add(1));
        shuffled.shuffle(&mut rng);
        output.push((
            format!("seeded_restart_{}", restart + 1),
            shuffled,
            restart % 2 == 0,
            restart % 2 == 1,
            false,
            restart % 3 == 2,
        ));
    }
    output
}

mod learned;
use learned::container_component_bounds;
pub(super) use learned::{
    alternating_fill, largest_container_rectangle, learned_lattice_layouts, learned_motif_layouts,
    prepare_fixed,
};

#[allow(
    clippy::too_many_arguments,
    reason = "the placement loop keeps independent strategy flags and mutable run instrumentation explicit"
)]
pub(super) fn structured_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    stagger: bool,
    columns: bool,
    cross_high: bool,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    let fill_bounds = container_component_bounds(prepared);
    for &variant_index in order {
        let variant = &prepared.variants[variant_index];
        let pitch_x =
            variant.bounds.width() + prepared.problem.clearance.item_to_item + EPSILON * 10.0;
        let pitch_y =
            variant.bounds.height() + prepared.problem.clearance.item_to_item + EPSILON * 10.0;
        // Each disconnected material component needs its own scan origin. Using the scene-wide
        // bounds makes the empty space between components part of the row/column phase, so adding
        // unrelated stock can remove placements that the same component accepts in isolation.
        // A one-component scene follows the original loop exactly.
        for component in &fill_bounds {
            for origin_high in [false, true] {
                if columns {
                    let mut column = 0usize;
                    let mut x = if cross_high {
                        component.max_x
                            - variant.bounds.max_x
                            - prepared.problem.clearance.item_to_boundary
                    } else {
                        component.min_x - variant.bounds.min_x
                            + prepared.problem.clearance.item_to_boundary
                    };
                    loop {
                        let cross_beyond = if cross_high {
                            x + variant.bounds.min_x < component.min_x - EPSILON
                        } else {
                            x + variant.bounds.max_x > component.max_x + EPSILON
                        };
                        if cross_beyond {
                            break;
                        }
                        let offset = if stagger && column % 2 == 1 {
                            pitch_y / 2.0
                        } else {
                            0.0
                        };
                        let mut y = if origin_high {
                            component.max_y - variant.bounds.max_y - offset
                        } else {
                            component.min_y - variant.bounds.min_y + offset
                        };
                        loop {
                            if stop_requested(options, started, counters, observer) {
                                return;
                            }
                            let beyond = if origin_high {
                                y + variant.bounds.min_y < component.min_y - EPSILON
                            } else {
                                y + variant.bounds.max_y > component.max_y + EPSILON
                            };
                            if beyond {
                                break;
                            }
                            try_place(prepared, variant, x, y, placed, counters);
                            y += if origin_high { -pitch_y } else { pitch_y };
                        }
                        column += 1;
                        x += if cross_high { -pitch_x } else { pitch_x };
                    }
                    continue;
                }
                let mut row = 0usize;
                let mut y = if cross_high {
                    component.max_y
                        - variant.bounds.max_y
                        - prepared.problem.clearance.item_to_boundary
                } else {
                    component.min_y - variant.bounds.min_y
                        + prepared.problem.clearance.item_to_boundary
                };
                loop {
                    let cross_beyond = if cross_high {
                        y + variant.bounds.min_y < component.min_y - EPSILON
                    } else {
                        y + variant.bounds.max_y > component.max_y + EPSILON
                    };
                    if cross_beyond {
                        break;
                    }
                    let offset = if stagger && row % 2 == 1 {
                        pitch_x / 2.0
                    } else {
                        0.0
                    };
                    let mut x = if origin_high {
                        component.max_x - variant.bounds.max_x - offset
                    } else {
                        component.min_x - variant.bounds.min_x + offset
                    };
                    loop {
                        if stop_requested(options, started, counters, observer) {
                            return;
                        }
                        let beyond = if origin_high {
                            x + variant.bounds.min_x < component.min_x - EPSILON
                        } else {
                            x + variant.bounds.max_x > component.max_x + EPSILON
                        };
                        if beyond {
                            break;
                        }
                        try_place(prepared, variant, x, y, placed, counters);
                        x += if origin_high { -pitch_x } else { pitch_x };
                    }
                    row += 1;
                    y += if cross_high { -pitch_y } else { pitch_y };
                }
            }
        }
    }
}

pub(super) fn greedy_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    let step = options.grid_step;
    let fill_bounds = container_component_bounds(prepared);
    for &variant_index in order {
        let variant = &prepared.variants[variant_index];
        let mut positions = contact_positions(prepared, variant, placed);
        // Grid phase must be local to each material component for the same reason as structured
        // rows: empty inter-component distance is not usable stock and must not shift the sample
        // coordinates within a component.
        for component in &fill_bounds {
            let mut y = component.min_y - variant.bounds.min_y;
            while y + variant.bounds.max_y <= component.max_y + EPSILON {
                let mut x = component.min_x - variant.bounds.min_x;
                while x + variant.bounds.max_x <= component.max_x + EPSILON {
                    positions.push((x, y));
                    x += step;
                }
                y += step;
            }
        }
        positions.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.total_cmp(&b.0)));
        positions.dedup_by(|a, b| (a.0 - b.0).abs() < EPSILON && (a.1 - b.1).abs() < EPSILON);
        for (x, y) in positions {
            if stop_requested(options, started, counters, observer) {
                return;
            }
            try_place(prepared, variant, x, y, placed, counters);
        }
    }
}

/// Completes a locally improved incumbent using only contact-derived positions. This deliberately
/// omits the full structured grid already scanned by `greedy_fill`, making it cheap enough to run
/// after compaction and rotation in every portfolio attempt.
pub(super) fn contact_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    for &variant_index in order {
        let variant = &prepared.variants[variant_index];
        if item_count(placed, &variant.item_id)
            >= prepared.problem.items[variant.item_index].quantity as usize
        {
            continue;
        }
        // Immediately rescan a successful variant once. This exposes contacts created by the new
        // placement before unrelated angles consume the bounded completion budget.
        for _ in 0..2 {
            let count_before = placed.len();
            let mut positions = contact_positions(prepared, variant, placed);
            positions.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.total_cmp(&b.0)));
            positions.dedup_by(|a, b| (a.0 - b.0).abs() < EPSILON && (a.1 - b.1).abs() < EPSILON);
            for (x, y) in positions {
                if stop_requested(options, started, counters, observer) {
                    return;
                }
                try_place(prepared, variant, x, y, placed, counters);
            }
            if placed.len() == count_before {
                break;
            }
        }
    }
}

pub(super) fn completion_variant_order(
    prepared: &PreparedProblem,
    incumbent: &[CandidatePlacement],
) -> Vec<usize> {
    let mut order = (0..prepared.variants.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        let a_variant = &prepared.variants[*a];
        let b_variant = &prepared.variants[*b];
        let a_used = incumbent.iter().any(|placed| {
            placed.placement.item_id == a_variant.item_id
                && same_rotation(placed.placement.rotation_deg, a_variant.rotation_deg)
        });
        let b_used = incumbent.iter().any(|placed| {
            placed.placement.item_id == b_variant.item_id
                && same_rotation(placed.placement.rotation_deg, b_variant.rotation_deg)
        });
        let a_orthogonal = (a_variant.rotation_deg / 90.0).round() * 90.0;
        let b_orthogonal = (b_variant.rotation_deg / 90.0).round() * 90.0;
        (!a_used)
            .cmp(&(!b_used))
            .then_with(|| {
                ((a_variant.rotation_deg - a_orthogonal).abs() > EPSILON)
                    .cmp(&((b_variant.rotation_deg - b_orthogonal).abs() > EPSILON))
            })
            .then_with(|| a_variant.item_index.cmp(&b_variant.item_index))
            .then_with(|| a_variant.rotation_deg.total_cmp(&b_variant.rotation_deg))
            .then_with(|| a.cmp(b))
    });
    order
}

fn contact_positions(
    prepared: &PreparedProblem,
    variant: &crate::prepare::PreparedVariant,
    placed: &[CandidatePlacement],
) -> Vec<(f64, f64)> {
    let gap = prepared.problem.clearance.item_to_item + EPSILON * 10.0;
    let boundary_gap = prepared.problem.clearance.item_to_boundary + EPSILON * 10.0;
    let mut positions = vec![
        (
            prepared.container_bounds.min_x + boundary_gap - variant.bounds.min_x,
            prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y,
        ),
        (
            prepared.container_bounds.max_x - boundary_gap - variant.bounds.max_x,
            prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y,
        ),
        (
            prepared.container_bounds.min_x + boundary_gap - variant.bounds.min_x,
            prepared.container_bounds.max_y - boundary_gap - variant.bounds.max_y,
        ),
        (
            prepared.container_bounds.max_x - boundary_gap - variant.bounds.max_x,
            prepared.container_bounds.max_y - boundary_gap - variant.bounds.max_y,
        ),
    ];
    // Exact vertex and edge-midpoint alignment supplies useful contacts for rotated, concave,
    // and holed containers without materializing a full no-fit polygon.
    let container_contacts = prepared
        .container_contacts
        .iter()
        .take(24)
        .copied()
        .collect::<Vec<_>>();
    let item_contacts = variant
        .geometry
        .polygons
        .iter()
        .flat_map(|polygon| polygon_contact_points(polygon))
        .take(16)
        .collect::<Vec<_>>();
    for boundary in &container_contacts {
        for item in &item_contacts {
            positions.push((boundary.x - item.x, boundary.y - item.y));
        }
    }
    let mut contact_xs = Vec::new();
    let mut contact_ys = Vec::new();
    for existing in placed {
        let right = existing.bounds.max_x + gap - variant.bounds.min_x;
        let left = existing.bounds.min_x - gap - variant.bounds.max_x;
        let above = existing.bounds.max_y + gap - variant.bounds.min_y;
        let below = existing.bounds.min_y - gap - variant.bounds.max_y;
        contact_xs.extend([right, left]);
        contact_ys.extend([above, below]);
        positions.extend([
            (right, existing.placement.y),
            (left, existing.placement.y),
            (existing.placement.x, above),
            (existing.placement.x, below),
        ]);
    }
    // Intersect orthogonal contacts from different neighbours. These two-constraint points are
    // the inexpensive rectangular analogue of an exact-fit vertex in a collision-free region.
    for x in contact_xs.into_iter().take(12) {
        for y in contact_ys.iter().take(12) {
            positions.push((x, *y));
        }
    }
    for exclusion in &prepared.exclusions {
        let boundary = bounds(exclusion);
        positions.push((
            boundary.max_x + prepared.problem.clearance.item_to_exclusion - variant.bounds.min_x,
            boundary.min_y - variant.bounds.min_y,
        ));
        positions.push((
            boundary.min_x - prepared.problem.clearance.item_to_exclusion - variant.bounds.max_x,
            boundary.min_y - variant.bounds.min_y,
        ));
    }
    positions
}

fn polygon_contact_points(polygon: &[crate::Point]) -> impl Iterator<Item = crate::Point> + '_ {
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
}

pub(super) fn compact(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placed: &mut [CandidatePlacement],
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    for index in 0..placed.len() {
        if placed[index].placement.fixed {
            continue;
        }
        for (dx, dy) in [(-options.grid_step, 0.0), (0.0, -options.grid_step)] {
            loop {
                if stop_requested(options, started, counters, observer) {
                    return;
                }
                let variant = prepared
                    .variants
                    .iter()
                    .find(|variant| {
                        variant.item_id == placed[index].placement.item_id
                            && same_rotation(
                                variant.rotation_deg,
                                placed[index].placement.rotation_deg,
                            )
                    })
                    .unwrap();
                let moved = candidate(
                    variant,
                    placed[index].placement.x + dx,
                    placed[index].placement.y + dy,
                    false,
                );
                let valid = feasible(
                    prepared,
                    &moved,
                    placed
                        .iter()
                        .enumerate()
                        .filter(|(other, _)| *other != index)
                        .map(|(_, entry)| entry),
                    counters,
                );
                counters.evaluated += 1;
                counters.iterations += 1;
                if valid {
                    counters.valid += 1;
                    placed[index] = moved;
                } else {
                    break;
                }
            }
        }
    }
}

fn try_place(
    prepared: &PreparedProblem,
    variant: &crate::prepare::PreparedVariant,
    x: f64,
    y: f64,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
) {
    counters.evaluated += 1;
    counters.iterations += 1;
    if item_count(placed, &variant.item_id)
        >= prepared.problem.items[variant.item_index].quantity as usize
    {
        return;
    }
    let next = candidate(variant, x, y, false);
    if feasible(prepared, &next, placed.iter(), counters) {
        counters.valid += 1;
        placed.push(next);
    } else if counters.failed_constructive_candidates.len() < 64 {
        counters.failed_constructive_candidates.push(next.placement);
    }
}

pub(super) fn feasible<'a>(
    prepared: &PreparedProblem,
    next: &CandidatePlacement,
    placed: impl Iterator<Item = &'a CandidatePlacement>,
    counters: &mut Counters,
) -> bool {
    let item = &prepared.problem.items[next_item_index(prepared, next)];
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
    let containment_started = Clock::start();
    counters.exact_geometry_checks += 1;
    let inside = set_inside(
        &next.geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    );
    counters.containment_check_ms += containment_started.elapsed_ms();
    if !inside {
        return false;
    }
    let collision_started = Clock::start();
    for (index, exclusion) in prepared.exclusions.iter().enumerate() {
        let required = prepared
            .problem
            .clearance
            .item_to_exclusion
            .max(prepared.problem.exclusions[index].clearance);
        if !next.bounds.overlaps(bounds(exclusion), required) {
            counters.broad_phase_rejections += 1;
            continue;
        }
        counters.exact_geometry_checks += 1;
        if sets_conflict(&next.geometry, exclusion, required) {
            counters.collision_check_ms += collision_started.elapsed_ms();
            return false;
        }
    }
    for existing in placed {
        if shared
            && existing.placement.item_id == next.placement.item_id
            && !same_rotation(existing.placement.rotation_deg, next.placement.rotation_deg)
        {
            return false;
        }
        let required = prepared.problem.clearance.item_to_item;
        if !next.bounds.overlaps(existing.bounds, required) {
            counters.broad_phase_rejections += 1;
            continue;
        }
        counters.exact_geometry_checks += 1;
        if sets_conflict(&next.geometry, &existing.geometry, required) {
            counters.collision_check_ms += collision_started.elapsed_ms();
            return false;
        }
    }
    counters.collision_check_ms += collision_started.elapsed_ms();
    true
}

fn next_item_index(prepared: &PreparedProblem, next: &CandidatePlacement) -> usize {
    prepared
        .problem
        .items
        .iter()
        .position(|item| item.id == next.placement.item_id)
        .expect("candidate item is prepared")
}

pub(super) fn rotate_and_compact(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placed: &mut [CandidatePlacement],
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    for index in 0..placed.len() {
        if placed[index].placement.fixed {
            continue;
        }
        let item_id = placed[index].placement.item_id.clone();
        let original = placed[index].clone();
        for variant_index in prepared
            .variants_by_item
            .get(&item_id)
            .into_iter()
            .flatten()
        {
            if stop_requested(options, started, counters, observer) {
                return;
            }
            let variant = &prepared.variants[*variant_index];
            if same_rotation(variant.rotation_deg, original.placement.rotation_deg) {
                continue;
            }
            let moved = candidate(variant, original.placement.x, original.placement.y, false);
            counters.evaluated += 1;
            counters.iterations += 1;
            if feasible(
                prepared,
                &moved,
                placed
                    .iter()
                    .enumerate()
                    .filter(|(other, _)| *other != index)
                    .map(|(_, entry)| entry),
                counters,
            ) {
                counters.valid += 1;
                placed[index] = moved;
                break;
            }
        }
    }
    compact(prepared, options, placed, counters, started, observer);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn remove_reinsert(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) -> bool {
    let movable = placed
        .iter()
        .enumerate()
        .filter(|(_, entry)| !entry.placement.fixed)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if movable.len() < 2 || counters.iterations >= options.max_iterations {
        return false;
    }

    // Boundary placements tend to encode the greedy decision that blocked the next item. Try a
    // few distinct anchors and remove their closest neighbours so reinsertion can change both
    // order and rotation without turning this bounded pass into an unbounded destroy/repair loop.
    let mut anchors = movable.clone();
    anchors.sort_by(|a, b| {
        placed[*b]
            .bounds
            .max_y
            .total_cmp(&placed[*a].bounds.max_y)
            .then_with(|| placed[*b].bounds.max_x.total_cmp(&placed[*a].bounds.max_x))
            .then_with(|| a.cmp(b))
    });
    if let Some(rightmost) = movable.iter().max_by(|a, b| {
        placed[**a]
            .bounds
            .max_x
            .total_cmp(&placed[**b].bounds.max_x)
    }) {
        anchors.insert(0, *rightmost);
    }
    let mut unique_anchors = Vec::new();
    for anchor in anchors {
        if !unique_anchors.contains(&anchor) {
            unique_anchors.push(anchor);
            if unique_anchors.len() == 3 {
                break;
            }
        }
    }

    let original = placed.to_vec();
    let mut best = original.clone();
    let trial_count = unique_anchors.len() as u64;
    for (trial_index, anchor) in unique_anchors.into_iter().enumerate() {
        if stop_requested(options, started, counters, observer) {
            break;
        }
        let anchor_x = (original[anchor].bounds.min_x + original[anchor].bounds.max_x) / 2.0;
        let anchor_y = (original[anchor].bounds.min_y + original[anchor].bounds.max_y) / 2.0;
        let mut neighbourhood = movable
            .iter()
            .copied()
            .map(|index| {
                let center_x = (original[index].bounds.min_x + original[index].bounds.max_x) / 2.0;
                let center_y = (original[index].bounds.min_y + original[index].bounds.max_y) / 2.0;
                let distance = (center_x - anchor_x).powi(2) + (center_y - anchor_y).powi(2);
                (distance, index)
            })
            .collect::<Vec<_>>();
        neighbourhood.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let removed = neighbourhood
            .into_iter()
            .take(3.min(movable.len()))
            .map(|(_, index)| index)
            .collect::<Vec<_>>();
        let mut trial = original
            .iter()
            .enumerate()
            .filter(|(index, _)| !removed.contains(index))
            .map(|(_, entry)| entry.clone())
            .collect::<Vec<_>>();

        let trials_left = trial_count.saturating_sub(trial_index as u64).max(1);
        let trial_budget = (options.max_iterations - counters.iterations).div_ceil(trials_left);
        let mut trial_options = *options;
        trial_options.max_iterations = (counters.iterations + trial_budget)
            .max(counters.iterations + 1)
            .min(options.max_iterations);
        greedy_fill(
            prepared,
            &trial_options,
            order,
            &mut trial,
            counters,
            started,
            observer,
        );
        if trial.len() > best.len()
            || (trial.len() == best.len() && layout_key(&trial) < layout_key(&best))
        {
            best = trial;
        }
        clear_local_limit(counters, options);
    }

    let improved = best.len() > original.len()
        || (best.len() == original.len() && layout_key(&best) < layout_key(&original));
    if improved {
        *placed = best;
    }
    improved
}
