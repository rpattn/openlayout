use super::*;

pub(super) struct ExactSliceOutcome {
    pub placements: Vec<Placement>,
}

/// Solves a narrow, proof-producing vertical-slice domain exactly.
///
/// Every admissible item is a fixed-orientation axis-aligned rectangle spanning the complete
/// usable container height. Vertical translation is fixed and every placement consumes one
/// horizontal interval. Sorting the finite requested copies by width is therefore an exact
/// maximum-cardinality solution; pair clearance is the exact one-dimensional no-fit cut between
/// consecutive slices.
pub(super) fn solve_full_height_rectangles(
    prepared: &PreparedProblem,
) -> Option<ExactSliceOutcome> {
    if !prepared.problem.exclusions.is_empty()
        || !prepared.problem.fixed_placements.is_empty()
        || prepared.container.polygons.len() != 1
        || prepared.container.polygons[0].len() != 4
        || prepared.problem.items.is_empty()
    {
        return None;
    }
    let boundary = prepared.problem.clearance.item_to_boundary;
    let usable_height = prepared.container_bounds.height() - 2.0 * boundary;
    let usable_width = prepared.container_bounds.width() - 2.0 * boundary;
    if usable_height <= EPSILON || usable_width <= EPSILON {
        return None;
    }
    let mut copies = Vec::new();
    for (item_index, item) in prepared.problem.items.iter().enumerate() {
        if !matches!(item.shape, crate::Shape::Rectangle { .. })
            || !matches!(item.rotation_policy, crate::RotationPolicy::Discrete { .. })
        {
            return None;
        }
        let variant_ids = prepared.variants_by_item.get(&item.id)?;
        if variant_ids.len() != 1 {
            return None;
        }
        let variant = &prepared.variants[variant_ids[0]];
        if !axis_aligned_rectangle(&variant.geometry, variant.bounds)
            || (variant.bounds.height() - usable_height).abs() > EPSILON * 10.0
        {
            return None;
        }
        copies.extend(std::iter::repeat_n(
            (variant.bounds.width(), item_index, variant.id),
            item.quantity as usize,
        ));
        if copies.len() > 256 {
            return None;
        }
    }
    copies.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let gap = prepared.problem.clearance.item_to_item;
    let mut used_width = 0.0;
    let mut selected = Vec::new();
    for copy in copies {
        let next_width = used_width + if selected.is_empty() { 0.0 } else { gap } + copy.0;
        if next_width <= usable_width + EPSILON {
            selected.push(copy);
            used_width = next_width;
        }
    }
    let mut cursor = prepared.container_bounds.min_x + boundary;
    let placements = selected
        .into_iter()
        .map(|(width, _, variant_id)| {
            let variant = &prepared.variants[variant_id];
            let placement = Placement {
                item_id: variant.item_id.clone(),
                x: cursor - variant.bounds.min_x,
                y: prepared.container_bounds.min_y + boundary - variant.bounds.min_y,
                rotation_deg: variant.rotation_deg,
                fixed: false,
            };
            cursor += width + gap;
            placement
        })
        .collect();
    Some(ExactSliceOutcome { placements })
}

fn axis_aligned_rectangle(geometry: &PolygonSet, geometry_bounds: Bounds) -> bool {
    geometry.polygons.len() == 1
        && geometry.polygons[0].len() == 4
        && geometry.polygons[0].iter().all(|point| {
            ((point.x - geometry_bounds.min_x).abs() <= EPSILON
                || (point.x - geometry_bounds.max_x).abs() <= EPSILON)
                && ((point.y - geometry_bounds.min_y).abs() <= EPSILON
                    || (point.y - geometry_bounds.max_y).abs() <= EPSILON)
        })
}
