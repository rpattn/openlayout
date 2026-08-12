use crate::geometry::{
    EPSILON, bounds, container_region, set_inside, sets_conflict, shape_to_polygons, transform,
    union_set,
};
use crate::numeric::same_rotation;
use crate::{PackingError, PackingProblem, Placement, PreparedProblem, ValidationReport};
use std::collections::BTreeMap;

pub fn validate_problem(problem: &PackingProblem) -> Result<(), PackingError> {
    if problem.schema_version != 2 {
        return Err(PackingError::config(
            "unsupported packing schema; expected schema_version 2",
        ));
    }
    let mut region_ids = BTreeMap::new();
    for part in &problem.container.parts {
        if part.id.trim().is_empty() || region_ids.insert(part.id.clone(), ()).is_some() {
            return Err(PackingError::config(
                "container part identifiers must be non-empty and unique",
            ));
        }
        if !part.rotation_deg.is_finite()
            || !part.translation.x.is_finite()
            || !part.translation.y.is_finite()
        {
            return Err(PackingError::config(
                "container part transforms must be finite",
            ));
        }
        shape_to_polygons(&part.shape)?;
    }
    let container = container_region(&problem.container.parts)?;
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
        validate_rotation_policy(item)?;
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
        let geometry = union_set(&shape_to_polygons(&exclusion.shape)?);
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
            || !rotation_permitted(fixed.rotation_deg, &item.rotation_policy)
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
        if !rotation_permitted(placement.rotation_deg, &item.rotation_policy) {
            errors.push(format!(
                "placement {index} uses a rotation not permitted for '{}'",
                item.id
            ));
            continue;
        }
        let base = union_set(&shape_to_polygons(&item.shape)?);
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
            if sets_conflict(&geometry, exclusion, required) {
                errors.push(format!(
                    "placement {index} intersects exclusion '{}' or violates its clearance",
                    prepared.problem.exclusions[exclusion_index].id
                ));
            }
        }
        *counts.entry(item.id.clone()).or_default() += 1;
        geometries.push((index, geometry));
    }
    for item in &prepared.problem.items {
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
        if shared {
            let mut rotations = placements
                .iter()
                .filter(|placement| placement.item_id == item.id)
                .map(|placement| placement.rotation_deg);
            if let Some(first) = rotations.next()
                && rotations.any(|angle| !same_rotation(angle, first))
            {
                errors.push(format!("item '{}' requires one shared rotation", item.id));
            }
        }
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
                && sets_conflict(&geometries[first].1, &geometries[second].1, required)
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

pub(crate) fn rotation_permitted(rotation: f64, policy: &crate::RotationPolicy) -> bool {
    match policy {
        crate::RotationPolicy::Discrete { angles_deg, .. } => angles_deg
            .iter()
            .any(|candidate| same_rotation(rotation, *candidate)),
        crate::RotationPolicy::Continuous {
            min_deg, max_deg, ..
        } => crate::prepare::angle_in_range(rotation, *min_deg, *max_deg),
    }
}

fn validate_rotation_policy(item: &crate::Item) -> Result<(), PackingError> {
    match &item.rotation_policy {
        crate::RotationPolicy::Discrete { angles_deg, .. }
            if angles_deg.is_empty() || angles_deg.iter().any(|angle| !angle.is_finite()) =>
        {
            Err(PackingError::config(format!(
                "item '{}' requires finite discrete rotations",
                item.id
            )))
        }
        crate::RotationPolicy::Continuous {
            min_deg, max_deg, ..
        } if !min_deg.is_finite()
            || !max_deg.is_finite()
            || max_deg <= min_deg
            || max_deg - min_deg > 360.0 + EPSILON =>
        {
            Err(PackingError::config(format!(
                "item '{}' requires a continuous rotation span in (0, 360] degrees",
                item.id
            )))
        }
        _ => Ok(()),
    }
}
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < EPSILON
}
