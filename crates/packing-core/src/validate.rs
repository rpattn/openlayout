use crate::geometry::{
    EPSILON, bounds, set_distance, set_inside, sets_overlap, shape_to_polygons, transform,
};
use crate::{PackingError, PackingProblem, Placement, PreparedProblem, ValidationReport};
use std::collections::BTreeMap;

pub fn validate_problem(problem: &PackingProblem) -> Result<(), PackingError> {
    let container = shape_to_polygons(&problem.container.boundary)?;
    if container.polygons.len() != 1 {
        return Err(PackingError::geometry(
            "container must be a single polygonal boundary",
        ));
    }
    if problem.items.is_empty() {
        return Err(PackingError::config(
            "at least one item definition is required",
        ));
    }
    for value in [
        problem.clearance.item_to_item,
        problem.clearance.item_to_boundary,
        problem.clearance.item_to_exclusion,
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(PackingError::config(
                "clearances must be finite and non-negative",
            ));
        }
    }
    let mut item_ids = BTreeMap::new();
    for item in &problem.items {
        if item.id.trim().is_empty() || item_ids.insert(item.id.clone(), ()).is_some() {
            return Err(PackingError::config(
                "item identifiers must be non-empty and unique",
            ));
        }
        if item.quantity == 0 {
            return Err(PackingError::config(format!(
                "item '{}' has zero quantity",
                item.id
            )));
        }
        if item.rotations.is_empty() || item.rotations.iter().any(|rotation| !rotation.is_finite())
        {
            return Err(PackingError::config(format!(
                "item '{}' requires finite permitted rotations",
                item.id
            )));
        }
        shape_to_polygons(&item.shape)?;
    }
    let mut exclusion_ids = BTreeMap::new();
    for exclusion in &problem.exclusions {
        if exclusion.id.trim().is_empty()
            || exclusion_ids.insert(exclusion.id.clone(), ()).is_some()
        {
            return Err(PackingError::config(
                "exclusion identifiers must be non-empty and unique",
            ));
        }
        if !exclusion.clearance.is_finite() || exclusion.clearance < 0.0 {
            return Err(PackingError::config(
                "exclusion clearance must be finite and non-negative",
            ));
        }
        let geometry = shape_to_polygons(&exclusion.shape)?;
        if !set_inside(&geometry, &container, 0.0) {
            return Err(PackingError::geometry(format!(
                "exclusion '{}' is not inside the container",
                exclusion.id
            )));
        }
    }
    for fixed in &problem.fixed_placements {
        let Some(item) = problem.items.iter().find(|item| item.id == fixed.item_id) else {
            return Err(PackingError::config(format!(
                "fixed placement references unknown item '{}'",
                fixed.item_id
            )));
        };
        if !fixed.x.is_finite()
            || !fixed.y.is_finite()
            || !fixed.rotation_deg.is_finite()
            || !rotation_permitted(fixed.rotation_deg, &item.rotations)
        {
            return Err(PackingError::config(format!(
                "fixed placement for '{}' has an invalid transform",
                fixed.item_id
            )));
        }
    }
    Ok(())
}

pub fn validate_placements(
    prepared: &PreparedProblem,
    placements: &[Placement],
) -> Result<ValidationReport, PackingError> {
    let mut errors = Vec::new();
    let mut geometries = Vec::new();
    let mut counts = BTreeMap::<String, usize>::new();
    for (index, placement) in placements.iter().enumerate() {
        let Some(item) = prepared
            .problem
            .items
            .iter()
            .find(|item| item.id == placement.item_id)
        else {
            errors.push(format!(
                "placement {index} references unknown item '{}'",
                placement.item_id
            ));
            continue;
        };
        if !placement.x.is_finite()
            || !placement.y.is_finite()
            || !placement.rotation_deg.is_finite()
        {
            errors.push(format!("placement {index} has a non-finite transform"));
            continue;
        }
        if !rotation_permitted(placement.rotation_deg, &item.rotations) {
            errors.push(format!(
                "placement {index} uses a rotation not permitted for '{}'",
                item.id
            ));
            continue;
        }
        let base = shape_to_polygons(&item.shape)?;
        let geometry = transform(&base, placement.rotation_deg, placement.x, placement.y);
        if !set_inside(
            &geometry,
            &prepared.container,
            prepared.problem.clearance.item_to_boundary,
        ) {
            errors.push(format!(
                "placement {index} is outside the container or violates boundary clearance"
            ));
        }
        for (exclusion_index, exclusion) in prepared.exclusions.iter().enumerate() {
            let required = prepared
                .problem
                .clearance
                .item_to_exclusion
                .max(prepared.problem.exclusions[exclusion_index].clearance);
            if sets_overlap(&geometry, exclusion)
                || set_distance(&geometry, exclusion) + EPSILON < required
            {
                errors.push(format!(
                    "placement {index} intersects exclusion '{}' or violates its clearance",
                    prepared.problem.exclusions[exclusion_index].id
                ));
            }
        }
        *counts.entry(item.id.clone()).or_default() += 1;
        geometries.push((index, geometry));
    }
    for (item_id, count) in counts {
        let limit = prepared
            .problem
            .items
            .iter()
            .find(|item| item.id == item_id)
            .unwrap()
            .quantity as usize;
        if count > limit {
            errors.push(format!(
                "item '{item_id}' exceeds its quantity limit of {limit}"
            ));
        }
    }
    for first in 0..geometries.len() {
        for second in (first + 1)..geometries.len() {
            let a_bounds = bounds(&geometries[first].1);
            let b_bounds = bounds(&geometries[second].1);
            let required = prepared.problem.clearance.item_to_item;
            if a_bounds.overlaps(b_bounds, required)
                && (sets_overlap(&geometries[first].1, &geometries[second].1)
                    || set_distance(&geometries[first].1, &geometries[second].1) + EPSILON
                        < required)
            {
                errors.push(format!(
                    "placements {} and {} overlap or violate item clearance",
                    geometries[first].0, geometries[second].0
                ));
            }
        }
    }
    validate_fixed(prepared, placements, &mut errors);
    Ok(ValidationReport {
        valid: errors.is_empty(),
        errors,
    })
}

fn validate_fixed(prepared: &PreparedProblem, placements: &[Placement], errors: &mut Vec<String>) {
    let mut used = vec![false; placements.len()];
    for fixed in &prepared.problem.fixed_placements {
        let found = placements.iter().enumerate().find(|(index, placement)| {
            !used[*index]
                && placement.fixed
                && placement.item_id == fixed.item_id
                && close(placement.x, fixed.x)
                && close(placement.y, fixed.y)
                && same_rotation(placement.rotation_deg, fixed.rotation_deg)
        });
        if let Some((index, _)) = found {
            used[index] = true;
        } else {
            errors.push(format!(
                "fixed placement for '{}' was changed or omitted",
                fixed.item_id
            ));
        }
    }
    if placements
        .iter()
        .enumerate()
        .any(|(index, placement)| placement.fixed && !used[index])
    {
        errors.push("result contains a placement incorrectly marked as fixed".to_string());
    }
}

pub(crate) fn rotation_permitted(rotation: f64, allowed: &[f64]) -> bool {
    allowed
        .iter()
        .any(|candidate| same_rotation(rotation, *candidate))
}
fn same_rotation(a: f64, b: f64) -> bool {
    (a - b).rem_euclid(360.0).min((b - a).rem_euclid(360.0)) < EPSILON
}
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < EPSILON
}
