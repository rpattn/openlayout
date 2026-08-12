use super::*;

pub(super) fn generate_candidates(
    prepared: &PreparedProblem,
    state: &SearchState,
    config: &SearchConfig,
    metrics: &mut SearchMetrics,
    observer: &mut dyn SolveObserver,
    cached_static: Option<&[Candidate]>,
) -> Option<CandidateBatch> {
    let started = Clock::start();
    let mut references = cached_static
        .map(|candidates| {
            candidates
                .iter()
                .enumerate()
                .filter(|(_, candidate)| {
                    let item_index = prepared.variants[candidate.variant_id].item_index;
                    state.counts[item_index] < prepared.problem.items[item_index].quantity
                })
                .map(|(index, candidate)| CandidateRef {
                    origin: CandidateOrigin::Static(index),
                    source: candidate.source,
                    contact_support: candidate.contact_support,
                    score: 0.0,
                    id: candidate.id,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut dynamic = Vec::new();
    let boundary_points = prepared.container_contacts.iter().take(32);
    let exclusion_points = prepared.exclusion_contacts.iter().take(24);
    for variant in &prepared.variants {
        if observer.should_cancel() {
            metrics.cancelled = true;
            return None;
        }
        let item_index = variant.item_index;
        let item = &prepared.problem.items[item_index];
        if state.counts[item_index] >= prepared.problem.items[item_index].quantity {
            continue;
        }
        let boundary_gap = prepared.problem.clearance.item_to_boundary + EPSILON * 10.0;
        let mut positions = Vec::new();
        let quantum = (EPSILON * 100.0).max(1e-7);
        let mut seen = references
            .iter()
            .enumerate()
            .filter(|(_, reference)| {
                reference
                    .candidate(cached_static.unwrap_or(&[]), &dynamic)
                    .variant_id
                    == variant.id
            })
            .map(|(index, reference)| {
                let candidate = reference.candidate(cached_static.unwrap_or(&[]), &dynamic);
                (
                    (
                        (candidate.x / quantum).round() as i64,
                        (candidate.y / quantum).round() as i64,
                    ),
                    index,
                )
            })
            .collect::<BTreeMap<_, _>>();
        if cached_static.is_none() {
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
        }
        let item_points = polygon_set_contact_points(&variant.geometry, 16);
        let dynamic_item_point_count = detailed_contact_limit(&variant.geometry);
        let prioritize_exact_fits = prefers_exact_fit_priority(&variant.geometry);
        if cached_static.is_none() {
            for boundary in boundary_points.clone() {
                for item in &item_points {
                    positions.push((
                        boundary.x - item.x,
                        boundary.y - item.y,
                        CandidateSource::BoundaryContact,
                    ));
                }
            }
            for boundary in exclusion_points.clone() {
                for item in item_points.iter().take(8) {
                    positions.push((
                        boundary.x - item.x,
                        boundary.y - item.y,
                        CandidateSource::ExclusionContact,
                    ));
                }
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
            if cached_static.is_some() && existing.placement.fixed {
                continue;
            }
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
            let existing_points = polygon_set_contact_points(
                &existing.geometry,
                detailed_contact_limit(&existing.geometry),
            );
            for anchor in existing_points {
                for item in item_points.iter().take(dynamic_item_point_count) {
                    positions.push((
                        anchor.x - item.x,
                        anchor.y - item.y,
                        CandidateSource::ItemContact,
                    ));
                }
            }
            if config.use_nfp_events
                && matches!(item.rotation_policy, crate::RotationPolicy::Discrete { .. })
            {
                positions.extend(
                    fixed_rotation_nfp_events(&existing.geometry, &variant.geometry)
                        .into_iter()
                        .take(24)
                        .map(|point| (point.x, point.y, CandidateSource::ItemContact)),
                );
            }
        }
        // Combining an x-contact from one obstacle with a y-contact from another produces the
        // finite two-constraint intersections that often close a corner-shaped gap.
        for x in contact_xs.into_iter().take(12) {
            for y in contact_ys.iter().take(12) {
                positions.push((x, *y, CandidateSource::ItemContact));
            }
        }
        if cached_static.is_none() {
            let mut y = prepared.container_bounds.min_y + boundary_gap - variant.bounds.min_y;
            let mut row_index = 0usize;
            while y + variant.bounds.max_y
                <= prepared.container_bounds.max_y - boundary_gap + EPSILON
            {
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
        }
        positions.sort_by(|a, b| {
            a.2.cmp(&b.2)
                .then_with(|| a.1.total_cmp(&b.1))
                .then_with(|| a.0.total_cmp(&b.0))
        });
        for (x, y, source) in positions {
            if !x.is_finite() || !y.is_finite() {
                continue;
            }
            let key = ((x / quantum).round() as i64, (y / quantum).round() as i64);
            if let Some(index) = seen.get(&key).copied() {
                if prioritize_exact_fits && is_contact_source(source) {
                    references[index].contact_support =
                        references[index].contact_support.saturating_add(1);
                    if candidate_source_bonus(source)
                        > candidate_source_bonus(references[index].source)
                    {
                        references[index].source = source;
                    }
                }
                continue;
            }
            let dynamic_index = dynamic.len();
            dynamic.push(Candidate {
                id: 0,
                variant_id: variant.id,
                x,
                y,
                bounds: variant.bounds.translated(x, y),
                source,
                contact_support: u16::from(is_contact_source(source)),
                score: 0.0,
            });
            let index = references.len();
            references.push(CandidateRef {
                origin: CandidateOrigin::Dynamic(dynamic_index),
                source,
                contact_support: u16::from(is_contact_source(source)),
                score: 0.0,
                id: cached_static.map_or(0, |candidates| {
                    candidates.len() as u64 + dynamic_index as u64
                }),
            });
            seen.insert(key, index);
        }
    }
    if cached_static.is_none() {
        references.sort_by(|left, right| {
            let a = left.candidate(&[], &dynamic);
            let b = right.candidate(&[], &dynamic);
            a.variant_id
                .cmp(&b.variant_id)
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| a.y.total_cmp(&b.y))
                .then_with(|| a.x.total_cmp(&b.x))
        });
        for (id, reference) in references.iter_mut().enumerate() {
            reference.id = id as u64;
        }
    }
    metrics.generated_candidates += references.len() as u64;
    metrics.candidate_generation_ms += started.elapsed_ms();
    Some(CandidateBatch {
        references,
        dynamic,
    })
}

pub(super) fn score_candidates(
    prepared: &PreparedProblem,
    state: &SearchState,
    static_candidates: &[Candidate],
    batch: &mut CandidateBatch,
    metrics: &mut SearchMetrics,
) {
    let started = Clock::start();
    let alignment_index = (state.placed.len() > 24).then(|| AlignmentIndex::new(state));
    for reference in &mut batch.references {
        let candidate = reference.candidate(static_candidates, &batch.dynamic);
        let contact_bonus = candidate_source_bonus(reference.source);
        // Complex variants never accumulate support, so this stays a constant-time hot-path
        // operation without recounting their vertices for every candidate.
        let exact_fit_bonus = f64::from(reference.contact_support.saturating_sub(1).min(8)) * 3.0;
        let x = candidate.bounds.min_x - prepared.container_bounds.min_x;
        let y = candidate.bounds.min_y - prepared.container_bounds.min_y;
        let alignment = alignment_index.as_ref().map_or_else(
            || {
                state
                    .placed
                    .iter()
                    .filter(|placed| {
                        (placed.bounds.min_x - candidate.bounds.min_x).abs() <= EPSILON * 10.0
                            || (placed.bounds.min_y - candidate.bounds.min_y).abs()
                                <= EPSILON * 10.0
                    })
                    .count()
            },
            |index| index.count(candidate.bounds),
        ) as f64;
        reference.score = contact_bonus + exact_fit_bonus + alignment * 0.25 - y * 1e-3 - x * 1e-6;
    }
    batch.references.sort_by(|left, right| {
        let a = left.candidate(static_candidates, &batch.dynamic);
        let b = right.candidate(static_candidates, &batch.dynamic);
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| a.y.total_cmp(&b.y))
            .then_with(|| a.x.total_cmp(&b.x))
            .then_with(|| a.variant_id.cmp(&b.variant_id))
            .then_with(|| left.id.cmp(&right.id))
    });
    metrics.candidate_scoring_ms += started.elapsed_ms();
}

struct AlignmentIndex {
    by_x: Vec<(f64, usize)>,
    by_y: Vec<(f64, usize)>,
    coordinates: Vec<(f64, f64)>,
}

impl AlignmentIndex {
    fn new(state: &SearchState) -> Self {
        let coordinates = state
            .placed
            .iter()
            .map(|placed| (placed.bounds.min_x, placed.bounds.min_y))
            .collect::<Vec<_>>();
        let mut by_x = coordinates
            .iter()
            .enumerate()
            .map(|(index, (x, _))| (*x, index))
            .collect::<Vec<_>>();
        let mut by_y = coordinates
            .iter()
            .enumerate()
            .map(|(index, (_, y))| (*y, index))
            .collect::<Vec<_>>();
        by_x.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
        });
        by_y.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
        });
        Self {
            by_x,
            by_y,
            coordinates,
        }
    }

    fn count(&self, candidate: Bounds) -> usize {
        let tolerance = EPSILON * 10.0;
        let x_matches = matching_range(&self.by_x, candidate.min_x, tolerance);
        let y_matches = matching_range(&self.by_y, candidate.min_y, tolerance);
        let intersection = if x_matches.len() <= y_matches.len() {
            self.by_x[x_matches.clone()]
                .iter()
                .filter(|(_, index)| {
                    (self.coordinates[*index].1 - candidate.min_y).abs() <= tolerance
                })
                .count()
        } else {
            self.by_y[y_matches.clone()]
                .iter()
                .filter(|(_, index)| {
                    (self.coordinates[*index].0 - candidate.min_x).abs() <= tolerance
                })
                .count()
        };
        x_matches.len() + y_matches.len() - intersection
    }
}

fn matching_range(values: &[(f64, usize)], target: f64, tolerance: f64) -> std::ops::Range<usize> {
    let pivot = values.partition_point(|(value, _)| *value < target);
    let mut start = pivot;
    while start > 0 && (values[start - 1].0 - target).abs() <= tolerance {
        start -= 1;
    }
    let mut end = pivot;
    while end < values.len() && (values[end].0 - target).abs() <= tolerance {
        end += 1;
    }
    start..end
}

fn is_contact_source(source: CandidateSource) -> bool {
    matches!(
        source,
        CandidateSource::BoundaryContact
            | CandidateSource::ExclusionContact
            | CandidateSource::ItemContact
    )
}

fn candidate_source_bonus(source: CandidateSource) -> f64 {
    match source {
        CandidateSource::ItemContact => 20.0,
        CandidateSource::RegionExtremum => 15.0,
        CandidateSource::Structured => 10.0,
        CandidateSource::BoundaryContact => 3.0,
        CandidateSource::ExclusionContact => 2.0,
    }
}

fn fixed_rotation_nfp_events(existing: &PolygonSet, moving: &PolygonSet) -> Vec<crate::Point> {
    if existing.polygons.len() != 1
        || moving.polygons.len() != 1
        || existing.polygons[0].len() > 12
        || moving.polygons[0].len() > 12
        || !is_convex_polygon(&existing.polygons[0])
        || !is_convex_polygon(&moving.polygons[0])
    {
        return Vec::new();
    }
    let mut sums = existing.polygons[0]
        .iter()
        .flat_map(|fixed| {
            moving.polygons[0].iter().map(move |moving| crate::Point {
                x: fixed.x - moving.x,
                y: fixed.y - moving.y,
            })
        })
        .collect::<Vec<_>>();
    convex_hull(&mut sums)
}

fn is_convex_polygon(polygon: &[crate::Point]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut direction = 0.0_f64;
    for index in 0..polygon.len() {
        let turn = point_cross(
            polygon[index],
            polygon[(index + 1) % polygon.len()],
            polygon[(index + 2) % polygon.len()],
        );
        if turn.abs() <= EPSILON {
            continue;
        }
        if direction != 0.0 && turn.is_sign_positive() != direction.is_sign_positive() {
            return false;
        }
        direction = turn;
    }
    direction != 0.0
}

fn convex_hull(points: &mut Vec<crate::Point>) -> Vec<crate::Point> {
    points.sort_by(|left, right| {
        left.x
            .total_cmp(&right.x)
            .then_with(|| left.y.total_cmp(&right.y))
    });
    points.dedup_by(|left, right| {
        (left.x - right.x).abs() <= EPSILON && (left.y - right.y).abs() <= EPSILON
    });
    if points.len() <= 2 {
        return points.clone();
    }
    let mut lower = Vec::new();
    for point in points.iter().copied() {
        while lower.len() >= 2
            && point_cross(lower[lower.len() - 2], lower[lower.len() - 1], point) <= EPSILON
        {
            lower.pop();
        }
        lower.push(point);
    }
    let mut upper = Vec::new();
    for point in points.iter().rev().copied() {
        while upper.len() >= 2
            && point_cross(upper[upper.len() - 2], upper[upper.len() - 1], point) <= EPSILON
        {
            upper.pop();
        }
        upper.push(point);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower.sort_by(|left, right| {
        left.y
            .total_cmp(&right.y)
            .then_with(|| left.x.total_cmp(&right.x))
    });
    lower
}

fn point_cross(a: crate::Point, b: crate::Point, c: crate::Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

pub(super) fn feasible_candidate(
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
    let geometry = Arc::new(transform(&variant.geometry, 0.0, candidate.x, candidate.y));
    let containment_started = Clock::start();
    metrics.exact_geometry_checks += 1;
    let inside = set_inside(
        &geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    );
    metrics.containment_check_ms += containment_started.elapsed_ms();
    if !inside {
        return None;
    }
    let collision_started = Clock::start();
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
        if sets_conflict(&geometry, exclusion, required) {
            metrics.collision_check_ms += collision_started.elapsed_ms();
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
        metrics.collision_check_ms += collision_started.elapsed_ms();
        return None;
    }
    for index in spatial.query(candidate.bounds, prepared.problem.clearance.item_to_item) {
        let existing = &state.placed[index];
        if shared_rotation
            && existing.placement.item_id == variant.item_id
            && angular_distance(existing.placement.rotation_deg, variant.rotation_deg) > EPSILON
        {
            metrics.collision_check_ms += collision_started.elapsed_ms();
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
        if sets_conflict(
            &geometry,
            &existing.geometry,
            prepared.problem.clearance.item_to_item,
        ) {
            metrics.collision_check_ms += collision_started.elapsed_ms();
            return None;
        }
    }
    metrics.collision_check_ms += collision_started.elapsed_ms();
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

pub(super) struct SpatialIndex {
    cell_size: f64,
    cells: BTreeMap<(i64, i64), Vec<usize>>,
    placement_count: usize,
}

impl SpatialIndex {
    pub(super) fn new(state: &SearchState, cell_size: f64) -> Self {
        let cell_size = cell_size.max(1e-6);
        let mut cells = BTreeMap::new();
        for (index, placed) in state.placed.iter().enumerate() {
            for key in cell_keys(placed.bounds, 0.0, cell_size) {
                cells.entry(key).or_insert_with(Vec::new).push(index);
            }
        }
        Self {
            cell_size,
            cells,
            placement_count: state.placed.len(),
        }
    }

    fn query(&self, bounds: Bounds, gap: f64) -> Vec<usize> {
        // States usually contain at most a few dozen placements. A stack bitmap avoids the tree
        // allocation/comparisons (and a second heap allocation) for the common case while the
        // fallback keeps arbitrary problem sizes and the old sorted result order.
        let mut found = Vec::with_capacity(self.placement_count.min(128));
        if self.placement_count <= 128 {
            let mut seen = 0u128;
            for key in cell_keys(bounds, gap, self.cell_size) {
                if let Some(indexes) = self.cells.get(&key) {
                    for &index in indexes {
                        let bit = 1u128 << index;
                        if seen & bit == 0 {
                            seen |= bit;
                            found.push(index);
                        }
                    }
                }
            }
        } else {
            let mut seen = vec![false; self.placement_count];
            for key in cell_keys(bounds, gap, self.cell_size) {
                if let Some(indexes) = self.cells.get(&key) {
                    for &index in indexes {
                        if !seen[index] {
                            seen[index] = true;
                            found.push(index);
                        }
                    }
                }
            }
        }
        found.sort_unstable();
        found
    }
}

fn cell_keys(bounds: Bounds, gap: f64, cell_size: f64) -> impl Iterator<Item = (i64, i64)> {
    let min_x = ((bounds.min_x - gap) / cell_size).floor() as i64;
    let max_x = ((bounds.max_x + gap) / cell_size).floor() as i64;
    let min_y = ((bounds.min_y - gap) / cell_size).floor() as i64;
    let max_y = ((bounds.max_y + gap) / cell_size).floor() as i64;
    (min_y..=max_y).flat_map(move |y| (min_x..=max_x).map(move |x| (x, y)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Shape;
    use crate::geometry::shape_to_polygons;

    #[test]
    fn convex_nfp_events_are_the_exact_rectangle_forbidden_region_corners() {
        let fixed = shape_to_polygons(&Shape::Rectangle {
            width: 2.0,
            height: 2.0,
        })
        .unwrap();
        let moving = shape_to_polygons(&Shape::Rectangle {
            width: 1.0,
            height: 1.0,
        })
        .unwrap();
        let events = fixed_rotation_nfp_events(&fixed, &moving);

        assert_eq!(events.len(), 4);
        for (x, y) in [(-1.5, -1.5), (1.5, -1.5), (-1.5, 1.5), (1.5, 1.5)] {
            assert!(
                events.iter().any(|point| {
                    (point.x - x).abs() <= EPSILON && (point.y - y).abs() <= EPSILON
                })
            );
        }
    }

    #[test]
    fn indexed_alignment_count_matches_the_direct_or_predicate() {
        let geometry = Arc::new(
            shape_to_polygons(&Shape::Rectangle {
                width: 1.0,
                height: 1.0,
            })
            .unwrap(),
        );
        let placed = (0..32)
            .map(|index| {
                let x = f64::from(index % 7);
                let y = f64::from(index % 5);
                Placed {
                    placement: Placement {
                        item_id: "fixture".into(),
                        x,
                        y,
                        rotation_deg: 0.0,
                        fixed: false,
                    },
                    variant_id: 0,
                    geometry: geometry.clone(),
                    bounds: Bounds {
                        min_x: x,
                        min_y: y,
                        max_x: x + 1.0,
                        max_y: y + 1.0,
                    },
                }
            })
            .collect::<Vec<_>>();
        let state = SearchState {
            placed,
            counts: Vec::new(),
            upper_bound: 0,
            secondary_score: 0.0,
        };
        let index = AlignmentIndex::new(&state);
        for (x, y) in [(0.0, 0.0), (3.0, 4.0), (6.0, 2.0), (20.0, 20.0)] {
            let candidate = Bounds {
                min_x: x,
                min_y: y,
                max_x: x + 1.0,
                max_y: y + 1.0,
            };
            let direct = state
                .placed
                .iter()
                .filter(|placed| {
                    (placed.bounds.min_x - x).abs() <= EPSILON * 10.0
                        || (placed.bounds.min_y - y).abs() <= EPSILON * 10.0
                })
                .count();
            assert_eq!(index.count(candidate), direct);
        }
    }
}
