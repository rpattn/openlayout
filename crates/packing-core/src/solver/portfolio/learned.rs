use super::*;

pub(in crate::solver) fn learned_lattice_layouts(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    fixed: &[CandidatePlacement],
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) -> Vec<(String, Vec<CandidatePlacement>)> {
    let mut layouts = Vec::new();
    let subdivision_started = Clock::start();
    let decomposed_cells = decomposed_regions(prepared);
    let component_bounds = container_component_bounds(prepared);
    let mut component_best = vec![Vec::new(); component_bounds.len()];
    counters.subdivision_ms += subdivision_started.elapsed_ms();
    'variant_portfolio: for variant in &prepared.variants {
        let horizontal_pitch = variant.bounds.width() + prepared.problem.clearance.item_to_item;
        for shift_fraction in [0.0, 0.5] {
            if stop_requested(options, started, counters, observer) {
                break 'variant_portfolio;
            }
            let row_shift = horizontal_pitch * shift_fraction;
            let vertical_pitch = learned_separation(
                variant,
                row_shift,
                true,
                prepared.problem.clearance.item_to_item,
                counters,
            );
            if !vertical_pitch.is_finite() || vertical_pitch <= EPSILON {
                continue;
            }
            for (vertical_high, horizontal_high) in
                [(false, false), (false, true), (true, false), (true, true)]
            {
                let mut placed = fixed.to_vec();
                lattice_fill(
                    prepared,
                    options,
                    variant,
                    prepared.container_bounds,
                    horizontal_pitch,
                    vertical_pitch,
                    row_shift,
                    vertical_high,
                    horizontal_high,
                    &mut placed,
                    counters,
                    started,
                    observer,
                );
                layouts.push((
                    format!(
                        "learned_lattice_{}_shift_{shift_fraction:.2}_{}{}",
                        variant.rotation_deg,
                        if vertical_high { "top" } else { "bottom" },
                        if horizontal_high { "_right" } else { "_left" }
                    ),
                    placed,
                ));
                if component_bounds.len() > 1 {
                    let mut component_aligned = fixed.to_vec();
                    for component in &component_bounds {
                        lattice_fill(
                            prepared,
                            options,
                            variant,
                            *component,
                            horizontal_pitch,
                            vertical_pitch,
                            row_shift,
                            vertical_high,
                            horizontal_high,
                            &mut component_aligned,
                            counters,
                            started,
                            observer,
                        );
                    }
                    if rotation_is_independent(
                        &prepared.problem.items[variant.item_index].rotation_policy,
                    ) {
                        retain_component_best(
                            &component_aligned,
                            fixed.len(),
                            &component_bounds,
                            &mut component_best,
                        );
                    }
                    layouts.push((
                        format!(
                            "learned_component_aligned_{}_shift_{shift_fraction:.2}_{}{}",
                            variant.rotation_deg,
                            if vertical_high { "top" } else { "bottom" },
                            if horizontal_high { "_right" } else { "_left" }
                        ),
                        component_aligned,
                    ));
                }
                if decomposed_cells.len() > 1 {
                    let mut decomposed = fixed.to_vec();
                    for cell in &decomposed_cells {
                        lattice_fill(
                            prepared,
                            options,
                            variant,
                            *cell,
                            horizontal_pitch,
                            vertical_pitch,
                            row_shift,
                            vertical_high,
                            horizontal_high,
                            &mut decomposed,
                            counters,
                            started,
                            observer,
                        );
                    }
                    layouts.push((
                        format!(
                            "learned_decomposed_{}_shift_{shift_fraction:.2}_{}{}",
                            variant.rotation_deg,
                            if vertical_high { "top" } else { "bottom" },
                            if horizontal_high { "_right" } else { "_left" }
                        ),
                        decomposed,
                    ));
                    if rotation_is_independent(
                        &prepared.problem.items[variant.item_index].rotation_policy,
                    ) {
                        let decomposed = &layouts.last().expect("layout was just pushed").1;
                        retain_component_best(
                            decomposed,
                            fixed.len(),
                            &component_bounds,
                            &mut component_best,
                        );
                    }
                }
            }
        }
    }
    if component_bounds.len() > 1 {
        let mut componentwise = fixed.to_vec();
        for entry in component_best.into_iter().flatten() {
            let item = prepared
                .problem
                .items
                .iter()
                .find(|item| item.id == entry.placement.item_id)
                .expect("candidate item exists");
            if item_count(&componentwise, &entry.placement.item_id) < item.quantity as usize {
                componentwise.push(entry);
            }
        }
        layouts.push((
            "learned_decomposed_componentwise".to_string(),
            componentwise,
        ));
    }
    layouts
}

fn retain_component_best(
    candidate: &[CandidatePlacement],
    fixed_count: usize,
    component_bounds: &[Bounds],
    component_best: &mut [Vec<CandidatePlacement>],
) {
    for (component_index, component) in component_bounds.iter().enumerate() {
        let within_component = candidate
            .iter()
            .skip(fixed_count)
            .filter(|entry| bounds_inside(entry.bounds, *component))
            .cloned()
            .collect::<Vec<_>>();
        if within_component.len() > component_best[component_index].len()
            || (within_component.len() == component_best[component_index].len()
                && layout_key(&within_component) < layout_key(&component_best[component_index]))
        {
            component_best[component_index] = within_component;
        }
    }
}

fn rotation_is_independent(policy: &crate::RotationPolicy) -> bool {
    matches!(
        policy,
        crate::RotationPolicy::Discrete {
            coupling: crate::RotationCoupling::Independent,
            ..
        } | crate::RotationPolicy::Continuous {
            coupling: crate::RotationCoupling::Independent,
            ..
        }
    )
}

fn decomposed_regions(prepared: &PreparedProblem) -> Vec<Bounds> {
    let component_bounds = container_component_bounds(prepared);
    let mut regions = Vec::new();
    for component in component_bounds {
        let mut xs = vec![component.min_x, component.max_x];
        let mut ys = vec![component.min_y, component.max_y];
        for polygon in &prepared.container.polygons {
            let polygon_bounds = bounds(&PolygonSet::new(vec![polygon.clone()]));
            if bounds_interiors_overlap(component, polygon_bounds)
                || bounds_equal(component, polygon_bounds)
            {
                for point in polygon {
                    xs.push(point.x);
                    ys.push(point.y);
                }
            }
        }
        for exclusion in &prepared.exclusions {
            let exclusion_bounds = bounds(exclusion);
            if bounds_interiors_overlap(component, exclusion_bounds) {
                xs.extend([exclusion_bounds.min_x, exclusion_bounds.max_x]);
                ys.extend([exclusion_bounds.min_y, exclusion_bounds.max_y]);
            }
        }
        normalize_axis(&mut xs, 12);
        normalize_axis(&mut ys, 12);
        if prepared.exclusions.is_empty() && rectangle_region_clear(prepared, component) {
            regions.push(component);
            continue;
        }
        let mut candidates = Vec::new();
        for left in 0..xs.len().saturating_sub(1) {
            for right in (left + 1)..xs.len() {
                for bottom in 0..ys.len().saturating_sub(1) {
                    for top in (bottom + 1)..ys.len() {
                        let candidate = Bounds {
                            min_x: xs[left],
                            min_y: ys[bottom],
                            max_x: xs[right],
                            max_y: ys[top],
                        };
                        if rectangle_region_clear(prepared, candidate) {
                            candidates.push(candidate);
                        }
                    }
                }
            }
        }
        candidates.sort_by(|a, b| {
            (b.width() * b.height())
                .total_cmp(&(a.width() * a.height()))
                .then_with(|| a.min_y.total_cmp(&b.min_y))
                .then_with(|| a.min_x.total_cmp(&b.min_x))
        });
        candidates.dedup_by(|a, b| bounds_equal(*a, *b));
        let component_start = regions.len();
        for candidate in candidates {
            if regions[component_start..]
                .iter()
                .all(|region| !bounds_interiors_overlap(*region, candidate))
            {
                regions.push(candidate);
                if regions.len() - component_start == 12 {
                    break;
                }
            }
        }
        if regions.len() == component_start {
            regions.push(component);
        }
    }
    regions
}

fn bounds_equal(a: Bounds, b: Bounds) -> bool {
    (a.min_x - b.min_x).abs() <= EPSILON
        && (a.min_y - b.min_y).abs() <= EPSILON
        && (a.max_x - b.max_x).abs() <= EPSILON
        && (a.max_y - b.max_y).abs() <= EPSILON
}

fn normalize_axis(values: &mut Vec<f64>, limit: usize) {
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() <= EPSILON);
    if values.len() <= limit {
        return;
    }
    let original = values.clone();
    values.clear();
    for index in 0..limit {
        let source = index * (original.len() - 1) / (limit - 1);
        values.push(original[source]);
    }
    values.dedup_by(|a, b| (*a - *b).abs() <= EPSILON);
}

fn rectangle_region_clear(prepared: &PreparedProblem, candidate: Bounds) -> bool {
    if candidate.width() <= EPSILON || candidate.height() <= EPSILON {
        return false;
    }
    let rectangle = rectangle_polygon(candidate);
    set_inside(&rectangle, &prepared.container, 0.0)
        && prepared
            .exclusions
            .iter()
            .all(|exclusion| !sets_overlap(&rectangle, exclusion))
}

fn rectangle_polygon(candidate: Bounds) -> PolygonSet {
    PolygonSet::new(vec![vec![
        crate::Point {
            x: candidate.min_x,
            y: candidate.min_y,
        },
        crate::Point {
            x: candidate.max_x,
            y: candidate.min_y,
        },
        crate::Point {
            x: candidate.max_x,
            y: candidate.max_y,
        },
        crate::Point {
            x: candidate.min_x,
            y: candidate.max_y,
        },
    ]])
}

fn rectangle_inside_container(prepared: &PreparedProblem, candidate: Bounds) -> bool {
    candidate.width() > EPSILON
        && candidate.height() > EPSILON
        && set_inside(&rectangle_polygon(candidate), &prepared.container, 0.0)
}

pub(in crate::solver) fn largest_container_rectangle(prepared: &PreparedProblem) -> Option<Bounds> {
    let mut xs = vec![
        prepared.container_bounds.min_x,
        prepared.container_bounds.max_x,
    ];
    let mut ys = vec![
        prepared.container_bounds.min_y,
        prepared.container_bounds.max_y,
    ];
    for point in prepared.container.polygons.iter().flatten() {
        xs.push(point.x);
        ys.push(point.y);
    }
    normalize_axis(&mut xs, 12);
    normalize_axis(&mut ys, 12);
    let mut best = None;
    for left in 0..xs.len().saturating_sub(1) {
        for right in (left + 1)..xs.len() {
            for bottom in 0..ys.len().saturating_sub(1) {
                for top in (bottom + 1)..ys.len() {
                    let candidate = Bounds {
                        min_x: xs[left],
                        min_y: ys[bottom],
                        max_x: xs[right],
                        max_y: ys[top],
                    };
                    if rectangle_inside_container(prepared, candidate)
                        && best.is_none_or(|current: Bounds| {
                            candidate.width() * candidate.height()
                                > current.width() * current.height() + EPSILON
                        })
                    {
                        best = Some(candidate);
                    }
                }
            }
        }
    }
    best
}

fn bounds_interiors_overlap(first: Bounds, second: Bounds) -> bool {
    first.min_x < second.max_x - EPSILON
        && first.max_x > second.min_x + EPSILON
        && first.min_y < second.max_y - EPSILON
        && first.max_y > second.min_y + EPSILON
}

pub(in crate::solver) fn learned_motif_layouts(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    fixed: &[CandidatePlacement],
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) -> Vec<(String, Vec<CandidatePlacement>)> {
    let mut layouts = Vec::new();
    // Motifs need a fresh origin in each disconnected component. Decomposition samples each
    // Boolean outer contour independently, so an unrelated component cannot change the phase
    // candidates available in an existing one.
    let fill_regions = decomposed_regions(prepared);
    let component_bounds = container_component_bounds(prepared);
    for (item_id, variant_indexes) in &prepared.variants_by_item {
        let item = prepared
            .problem
            .items
            .iter()
            .find(|item| &item.id == item_id)
            .expect("prepared item exists");
        if item.quantity < 2
            || matches!(
                item.rotation_policy,
                crate::RotationPolicy::Discrete {
                    coupling: crate::RotationCoupling::SharedPerItem,
                    ..
                } | crate::RotationPolicy::Continuous {
                    coupling: crate::RotationCoupling::SharedPerItem,
                    ..
                }
            )
        {
            continue;
        }
        // Pairwise contact offsets are intentionally a low-complexity polygon strategy. Curved
        // and compound variants make each offset/distance probe much more expensive and already
        // have dedicated lattice, contact-closure, and continuation paths. Applying the motif
        // cross-product to the studio capsule causes a large latency regression without adding a
        // useful seed.
        if variant_indexes.iter().any(|index| {
            prepared.variants[*index]
                .geometry
                .polygons
                .iter()
                .map(Vec::len)
                .sum::<usize>()
                > 16
        }) {
            continue;
        }
        let mut pairs = Vec::new();
        for first_position in 0..variant_indexes.len() {
            for second_position in (first_position + 1)..variant_indexes.len() {
                let first = &prepared.variants[variant_indexes[first_position]];
                let second = &prepared.variants[variant_indexes[second_position]];
                // Complementary polygon motifs most often come from a half-turn: an upright and
                // inverted triangle, for example. Rank those pairs before quarter-turn and nearby
                // continuous variants so the bounded pair portfolio does not spend all eight
                // slots on 90-degree combinations.
                let difference = (first.rotation_deg - second.rotation_deg)
                    .abs()
                    .rem_euclid(360.0);
                let priority = (difference - 180.0).abs();
                pairs.push((priority, first_position, second_position));
            }
        }
        pairs.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        let motifs = pairs
            .into_iter()
            .take(8)
            .map(|(_, first_position, second_position)| {
                let first = &prepared.variants[variant_indexes[first_position]];
                let second = &prepared.variants[variant_indexes[second_position]];
                (
                    first_position,
                    second_position,
                    select_motif_offsets(
                        best_motif_offsets(first, second, prepared.problem.clearance.item_to_item),
                        &component_bounds,
                        prepared.problem.clearance.item_to_boundary,
                    ),
                )
            })
            .collect::<Vec<_>>();
        let directions = [(false, false), (false, true), (true, false), (true, true)];
        let mut cached_pitches = vec![[None; 2]; motifs.len()];
        let mut component_best = vec![Vec::new(); component_bounds.len()];
        let mut probes = 0usize;
        'motif_portfolio: for offset_index in 0..2 {
            for (vertical_high, horizontal_high) in directions {
                // Round-robin the rotation pairs before trying another origin or secondary
                // contact offset. This keeps one angle from monopolising a fixed iteration slice
                // when several disconnected components must be filled.
                for (motif_index, (first_position, second_position, offsets)) in
                    motifs.iter().enumerate()
                {
                    if probes == 40
                        || stop_requested(options, started, counters, observer)
                        || offsets.get(offset_index).is_none()
                    {
                        if probes == 40 || counters.limit || counters.cancelled {
                            break 'motif_portfolio;
                        }
                        continue;
                    }
                    let first = &prepared.variants[variant_indexes[*first_position]];
                    let second = &prepared.variants[variant_indexes[*second_position]];
                    let (offset, motif_bounds) = offsets[offset_index];
                    // Direction only changes the origin from which this motif is filled. Its learned
                    // repeat distances are invariant, and recomputing both searches for all four
                    // directions used enough of the bounded baseline to starve later rotation pairs.
                    let (pitch_x, pitch_y) = *cached_pitches[motif_index][offset_index]
                        .get_or_insert_with(|| {
                            motif_pitch(
                                first,
                                second,
                                offset,
                                motif_bounds,
                                prepared.problem.clearance.item_to_item,
                                counters,
                            )
                        });
                    if pitch_x <= EPSILON || pitch_y <= EPSILON {
                        continue;
                    }
                    let mut placed = fixed.to_vec();
                    motif_fill(
                        prepared,
                        options,
                        first,
                        second,
                        offset,
                        motif_bounds,
                        pitch_x,
                        pitch_y,
                        &fill_regions,
                        vertical_high,
                        horizontal_high,
                        &mut placed,
                        counters,
                        started,
                        observer,
                    );
                    layouts.push((
                        format!(
                            "learned_motif_{}_{}_{}{}",
                            first.rotation_deg,
                            second.rotation_deg,
                            if vertical_high { "top" } else { "bottom" },
                            if horizontal_high { "_right" } else { "_left" }
                        ),
                        placed.clone(),
                    ));
                    for (component_index, component) in component_bounds.iter().enumerate() {
                        let within_component = placed
                            .iter()
                            .skip(fixed.len())
                            .filter(|entry| bounds_inside(entry.bounds, *component))
                            .cloned()
                            .collect::<Vec<_>>();
                        if within_component.len() > component_best[component_index].len()
                            || (within_component.len() == component_best[component_index].len()
                                && layout_key(&within_component)
                                    < layout_key(&component_best[component_index]))
                        {
                            component_best[component_index] = within_component;
                        }
                    }
                    probes += 1;
                }
            }
        }
        if component_bounds.len() > 1 {
            let mut componentwise = fixed.to_vec();
            let remaining_quantity =
                (item.quantity as usize).saturating_sub(item_count(fixed, item_id));
            for entry in component_best
                .into_iter()
                .flatten()
                .take(remaining_quantity)
            {
                componentwise.push(entry);
            }
            layouts.push(("learned_motif_componentwise".to_string(), componentwise));
        }
    }
    layouts
}

fn bounds_inside(inner: Bounds, outer: Bounds) -> bool {
    inner.min_x >= outer.min_x - EPSILON
        && inner.max_x <= outer.max_x + EPSILON
        && inner.min_y >= outer.min_y - EPSILON
        && inner.max_y <= outer.max_y + EPSILON
}

pub(super) fn container_component_bounds(prepared: &PreparedProblem) -> Vec<Bounds> {
    let mut components = prepared
        .container
        .polygons
        .iter()
        // Boolean-normalized outer contours are counter-clockwise; clockwise contours are holes.
        .filter(|polygon| contour_twice_area(polygon) > EPSILON)
        .map(|polygon| {
            let geometry = PolygonSet::new(vec![polygon.clone()]);
            bounds(&geometry)
        })
        .collect::<Vec<_>>();
    components.sort_by(|a, b| {
        (b.width() * b.height())
            .total_cmp(&(a.width() * a.height()))
            .then_with(|| a.min_y.total_cmp(&b.min_y))
            .then_with(|| a.min_x.total_cmp(&b.min_x))
    });
    if components.is_empty() {
        vec![prepared.container_bounds]
    } else {
        components
    }
}

fn contour_twice_area(polygon: &[crate::Point]) -> f64 {
    polygon
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let next = polygon[(index + 1) % polygon.len()];
            point.x * next.y - next.x * point.y
        })
        .sum()
}

fn best_motif_offsets(
    first: &crate::prepare::PreparedVariant,
    second: &crate::prepare::PreparedVariant,
    clearance: f64,
) -> Vec<(crate::Point, Bounds)> {
    let first_contacts = first
        .geometry
        .polygons
        .iter()
        .flat_map(|polygon| polygon_contact_points(polygon))
        .take(16)
        .collect::<Vec<_>>();
    let second_contacts = second
        .geometry
        .polygons
        .iter()
        .flat_map(|polygon| polygon_contact_points(polygon))
        .take(16)
        .collect::<Vec<_>>();
    let occupied_area = area(&first.geometry) + area(&second.geometry);
    let mut candidates = Vec::new();
    for first_point in &first_contacts {
        for second_point in &second_contacts {
            let contact_offset = crate::Point {
                x: first_point.x - second_point.x,
                y: first_point.y - second_point.y,
            };
            let Some(offset) = separated_motif_offset(
                &first.geometry,
                &second.geometry,
                contact_offset,
                clearance,
            ) else {
                continue;
            };
            let moved = transform(&second.geometry, 0.0, offset.x, offset.y);
            if sets_overlap(&first.geometry, &moved) {
                continue;
            }
            let mut polygons = first.geometry.polygons.clone();
            polygons.extend(moved.polygons);
            let motif_bounds = bounds(&PolygonSet::new(polygons));
            let box_area = motif_bounds.width() * motif_bounds.height();
            if !box_area.is_finite() || box_area <= EPSILON {
                continue;
            }
            candidates.push((
                box_area / occupied_area,
                motif_bounds.width() + motif_bounds.height(),
                offset,
                motif_bounds,
            ));
        }
    }
    candidates.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| a.1.total_cmp(&b.1))
            .then_with(|| a.2.x.total_cmp(&b.2.x))
            .then_with(|| a.2.y.total_cmp(&b.2.y))
    });
    candidates
        .dedup_by(|a, b| (a.2.x - b.2.x).abs() <= EPSILON && (a.2.y - b.2.y).abs() <= EPSILON);
    candidates
        .into_iter()
        .map(|(_, _, offset, motif_bounds)| (offset, motif_bounds))
        .collect()
}

fn select_motif_offsets(
    candidates: Vec<(crate::Point, Bounds)>,
    component_bounds: &[Bounds],
    boundary_clearance: f64,
) -> Vec<(crate::Point, Bounds)> {
    if component_bounds.len() <= 1 {
        return candidates.into_iter().take(2).collect();
    }
    let Some(primary) = candidates.first().copied() else {
        return Vec::new();
    };
    let repeat_capacity = |motif: Bounds| {
        component_bounds
            .iter()
            .map(|component| {
                let width = (component.width() - 2.0 * boundary_clearance).max(0.0);
                let height = (component.height() - 2.0 * boundary_clearance).max(0.0);
                if motif.width() > width + EPSILON || motif.height() > height + EPSILON {
                    0usize
                } else {
                    (width / motif.width()).floor() as usize
                        * (height / motif.height()).floor() as usize
                }
            })
            .sum::<usize>()
    };
    let alternative = candidates
        .iter()
        .copied()
        .enumerate()
        .skip(1)
        .max_by(|(a_index, (_, a_bounds)), (b_index, (_, b_bounds))| {
            repeat_capacity(*a_bounds)
                .cmp(&repeat_capacity(*b_bounds))
                .then_with(|| b_index.cmp(a_index))
        })
        .map(|(_, candidate)| candidate);
    let mut selected = vec![primary];
    if let Some(alternative) = alternative
        && ((alternative.0.x - primary.0.x).abs() > EPSILON
            || (alternative.0.y - primary.0.y).abs() > EPSILON)
    {
        selected.push(alternative);
    }
    selected
}

/// Moves a touching motif pair apart along its centre-to-centre direction until the requested
/// clearance is reached. Contact-derived pairs are already non-overlapping at zero clearance;
/// retaining their direction preserves complementary edge alignment for triangles and other
/// low-complexity polygons instead of falling back to their bounding boxes.
fn separated_motif_offset(
    first: &PolygonSet,
    second: &PolygonSet,
    contact_offset: crate::Point,
    clearance: f64,
) -> Option<crate::Point> {
    let length = contact_offset.x.hypot(contact_offset.y);
    if length <= EPSILON {
        return (clearance <= EPSILON).then_some(contact_offset);
    }
    let direction = crate::Point {
        x: contact_offset.x / length,
        y: contact_offset.y / length,
    };
    let offset_at = |extra: f64| crate::Point {
        x: contact_offset.x + direction.x * extra,
        y: contact_offset.y + direction.y * extra,
    };
    let separated = |extra: f64| {
        let offset = offset_at(extra);
        let moved = transform(second, 0.0, offset.x, offset.y);
        !sets_conflict(first, &moved, clearance)
    };
    if separated(0.0) {
        return Some(contact_offset);
    }
    let mut high = clearance.max(EPSILON * 10.0);
    let search_limit = length + clearance + bounds(first).width() + bounds(second).width();
    while high <= search_limit && !separated(high) {
        high *= 2.0;
    }
    if !separated(high) {
        return None;
    }
    let mut low = 0.0;
    for _ in 0..32 {
        let middle = (low + high) / 2.0;
        if separated(middle) {
            high = middle;
        } else {
            low = middle;
        }
    }
    Some(offset_at(high + EPSILON * 10.0))
}

#[allow(
    clippy::too_many_arguments,
    reason = "a learned motif carries two variants, its measured transform, and explicit run instrumentation"
)]
fn motif_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    first: &crate::prepare::PreparedVariant,
    second: &crate::prepare::PreparedVariant,
    offset: crate::Point,
    motif_bounds: Bounds,
    pitch_x: f64,
    pitch_y: f64,
    fill_regions: &[Bounds],
    vertical_high: bool,
    horizontal_high: bool,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    let boundary_clearance = prepared.problem.clearance.item_to_boundary;
    for fill_bounds in fill_regions {
        let mut y = if vertical_high {
            fill_bounds.max_y - motif_bounds.max_y - boundary_clearance
        } else {
            fill_bounds.min_y - motif_bounds.min_y + boundary_clearance
        };
        loop {
            let y_beyond = if vertical_high {
                y + motif_bounds.min_y < fill_bounds.min_y - EPSILON
            } else {
                y + motif_bounds.max_y > fill_bounds.max_y + EPSILON
            };
            if y_beyond {
                break;
            }
            let mut x = if horizontal_high {
                fill_bounds.max_x - motif_bounds.max_x - boundary_clearance
            } else {
                fill_bounds.min_x - motif_bounds.min_x + boundary_clearance
            };
            loop {
                if stop_requested(options, started, counters, observer) {
                    return;
                }
                let x_beyond = if horizontal_high {
                    x + motif_bounds.min_x < fill_bounds.min_x - EPSILON
                } else {
                    x + motif_bounds.max_x > fill_bounds.max_x + EPSILON
                };
                if x_beyond {
                    break;
                }
                try_place_pair(prepared, first, second, x, y, offset, placed, counters);
                x += if horizontal_high { -pitch_x } else { pitch_x };
            }
            // A repeated pair can leave room for one final member of an odd-length row.
            if !stop_requested(options, started, counters, observer) {
                try_place(prepared, first, x, y, placed, counters);
                try_place(
                    prepared,
                    second,
                    x + offset.x,
                    y + offset.y,
                    placed,
                    counters,
                );
            }
            y += if vertical_high { -pitch_y } else { pitch_y };
        }
    }
}

fn motif_pitch(
    first: &crate::prepare::PreparedVariant,
    second: &crate::prepare::PreparedVariant,
    offset: crate::Point,
    motif_bounds: Bounds,
    clearance: f64,
    counters: &mut Counters,
) -> (f64, f64) {
    let moved_second = transform(&second.geometry, 0.0, offset.x, offset.y);
    let mut motif_polygons = first.geometry.polygons.clone();
    motif_polygons.extend(moved_second.polygons);
    let motif = PolygonSet::new(motif_polygons);
    (
        learned_geometry_separation(&motif, motif_bounds, 0.0, false, clearance, counters),
        learned_geometry_separation(&motif, motif_bounds, 0.0, true, clearance, counters),
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "pair insertion keeps both variants and the measured relative transform explicit"
)]
fn try_place_pair(
    prepared: &PreparedProblem,
    first: &crate::prepare::PreparedVariant,
    second: &crate::prepare::PreparedVariant,
    x: f64,
    y: f64,
    offset: crate::Point,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
) {
    if item_count(placed, &first.item_id) + 2
        > prepared.problem.items[first.item_index].quantity as usize
    {
        return;
    }
    let first_candidate = candidate(first, x, y, false);
    let second_candidate = candidate(second, x + offset.x, y + offset.y, false);
    counters.evaluated += 2;
    counters.iterations += 2;
    if feasible(prepared, &first_candidate, placed.iter(), counters)
        && feasible(
            prepared,
            &second_candidate,
            placed.iter().chain(std::iter::once(&first_candidate)),
            counters,
        )
    {
        counters.valid += 2;
        placed.push(first_candidate);
        placed.push(second_candidate);
    }
}

#[allow(clippy::too_many_arguments)]
fn lattice_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    variant: &crate::prepare::PreparedVariant,
    fill_bounds: Bounds,
    horizontal_pitch: f64,
    vertical_pitch: f64,
    row_shift: f64,
    vertical_high: bool,
    horizontal_high: bool,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    let clearance = prepared.problem.clearance.item_to_boundary;
    let mut row = 0usize;
    let mut y = if vertical_high {
        fill_bounds.max_y - variant.bounds.max_y - clearance
    } else {
        fill_bounds.min_y - variant.bounds.min_y + clearance
    };
    loop {
        let y_beyond = if vertical_high {
            y + variant.bounds.min_y < fill_bounds.min_y - EPSILON
        } else {
            y + variant.bounds.max_y > fill_bounds.max_y + EPSILON
        };
        if y_beyond {
            break;
        }
        let shift = if row % 2 == 1 { row_shift } else { 0.0 };
        let mut x = if horizontal_high {
            fill_bounds.max_x - variant.bounds.max_x - clearance - shift
        } else {
            fill_bounds.min_x - variant.bounds.min_x + clearance + shift
        };
        loop {
            if stop_requested(options, started, counters, observer) {
                return;
            }
            let x_beyond = if horizontal_high {
                x + variant.bounds.min_x < fill_bounds.min_x - EPSILON
            } else {
                x + variant.bounds.max_x > fill_bounds.max_x + EPSILON
            };
            if x_beyond {
                break;
            }
            try_place(prepared, variant, x, y, placed, counters);
            x += if horizontal_high {
                -horizontal_pitch
            } else {
                horizontal_pitch
            };
        }
        row += 1;
        y += if vertical_high {
            -vertical_pitch
        } else {
            vertical_pitch
        };
    }
}

fn learned_separation(
    variant: &crate::prepare::PreparedVariant,
    orthogonal_offset: f64,
    vertical: bool,
    clearance: f64,
    counters: &mut Counters,
) -> f64 {
    learned_geometry_separation(
        &variant.geometry,
        variant.bounds,
        orthogonal_offset,
        vertical,
        clearance,
        counters,
    )
}

fn learned_geometry_separation(
    geometry: &PolygonSet,
    geometry_bounds: Bounds,
    orthogonal_offset: f64,
    vertical: bool,
    clearance: f64,
    counters: &mut Counters,
) -> f64 {
    let upper = if vertical {
        geometry_bounds.height()
    } else {
        geometry_bounds.width()
    } + clearance;
    let samples = 64;
    let mut previous = 0.0;
    for sample in 0..=samples {
        let separation = upper * sample as f64 / samples as f64;
        counters.iterations += 1;
        counters.evaluated += 1;
        if geometries_separated(geometry, orthogonal_offset, separation, vertical, clearance) {
            let mut low = previous;
            let mut high = separation;
            for _ in 0..24 {
                let middle = (low + high) / 2.0;
                counters.iterations += 1;
                counters.evaluated += 1;
                if geometries_separated(geometry, orthogonal_offset, middle, vertical, clearance) {
                    high = middle;
                } else {
                    low = middle;
                }
            }
            return high;
        }
        previous = separation;
    }
    upper
}

fn geometries_separated(
    geometry: &PolygonSet,
    orthogonal_offset: f64,
    separation: f64,
    vertical: bool,
    clearance: f64,
) -> bool {
    let moved = if vertical {
        transform(geometry, 0.0, orthogonal_offset, separation)
    } else {
        transform(geometry, 0.0, separation, orthogonal_offset)
    };
    !sets_conflict(geometry, &moved, clearance)
}

pub(in crate::solver) fn alternating_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: Clock,
    observer: &mut dyn SolveObserver,
) {
    for variant_indexes in prepared.variants_by_item.values() {
        if variant_indexes.len() < 2 {
            continue;
        }
        let variants = [
            &prepared.variants[variant_indexes[0]],
            &prepared.variants[variant_indexes[1]],
        ];
        let pitch_x = variants
            .iter()
            .map(|variant| variant.bounds.width())
            .fold(0.0, f64::max)
            + prepared.problem.clearance.item_to_item
            + EPSILON * 10.0;
        let pitch_y = variants
            .iter()
            .map(|variant| variant.bounds.height())
            .fold(0.0, f64::max)
            + prepared.problem.clearance.item_to_item
            + EPSILON * 10.0;
        let mut row = 0usize;
        let mut cell_y = prepared.container_bounds.min_y;
        while cell_y + pitch_y <= prepared.container_bounds.max_y + EPSILON {
            let mut column = 0usize;
            let mut cell_x = prepared.container_bounds.min_x;
            while cell_x + pitch_x <= prepared.container_bounds.max_x + EPSILON {
                if stop_requested(options, started, counters, observer) {
                    return;
                }
                let variant = variants[(row + column) % 2];
                let x = cell_x + (pitch_x - variant.bounds.width()) / 2.0 - variant.bounds.min_x;
                let y = cell_y + (pitch_y - variant.bounds.height()) / 2.0 - variant.bounds.min_y;
                try_place(prepared, variant, x, y, placed, counters);
                column += 1;
                cell_x += pitch_x;
            }
            row += 1;
            cell_y += pitch_y;
        }
    }
}

pub(in crate::solver) fn prepare_fixed(
    prepared: &PreparedProblem,
) -> Result<Vec<CandidatePlacement>, PackingError> {
    let mut output = Vec::new();
    for fixed in &prepared.problem.fixed_placements {
        let variant = prepared
            .variants
            .iter()
            .find(|variant| {
                variant.item_id == fixed.item_id
                    && same_rotation(variant.rotation_deg, fixed.rotation_deg)
            })
            .ok_or_else(|| {
                PackingError::config(format!(
                    "no prepared variant for fixed item '{}'",
                    fixed.item_id
                ))
            })?;
        output.push(candidate(variant, fixed.x, fixed.y, true));
    }
    let placements = output
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let report = validate_placements(prepared, &placements)?;
    if !report.valid {
        return Err(PackingError::new(
            PackingErrorKind::ImpossibleClearance,
            format!(
                "fixed placements are infeasible: {}",
                report.errors.join("; ")
            ),
        ));
    }
    Ok(output)
}
