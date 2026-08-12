use super::*;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

pub(crate) fn container_region(parts: &[RegionPart]) -> Result<PolygonSet, PackingError> {
    let mut additions = PolygonSet::new(Vec::new());
    let mut subtractions = PolygonSet::new(Vec::new());
    for (part, geometry) in parts.iter().zip(region_geometries(parts)?) {
        match part.operation {
            RegionOperation::Add => additions = overlay(&additions, &geometry, OverlayRule::Union),
            RegionOperation::Subtract => {
                subtractions = overlay(&subtractions, &geometry, OverlayRule::Union)
            }
        }
    }
    if additions.polygons.is_empty() {
        return Err(PackingError::geometry(
            "container requires at least one additive region",
        ));
    }
    let result = if subtractions.polygons.is_empty() {
        additions
    } else {
        overlay(&additions, &subtractions, OverlayRule::Difference)
    };
    if result.polygons.is_empty() || area(&result) <= EPSILON {
        return Err(PackingError::geometry("container Boolean result is empty"));
    }
    Ok(result)
}

pub fn resolve_problem_geometry(problem: &PackingProblem) -> ResolvedProblemGeometry {
    let container = container_region(&problem.container.parts)
        .map(|geometry| geometry.polygons)
        .unwrap_or_default();
    let items = problem
        .items
        .iter()
        .map(|item| NamedResolvedGeometry {
            id: item.id.clone(),
            polygons: shape_to_polygons(&item.shape)
                .map(|geometry| union_set(&geometry).polygons)
                .unwrap_or_default(),
        })
        .collect();
    let exclusions = problem
        .exclusions
        .iter()
        .map(|exclusion| NamedResolvedGeometry {
            id: exclusion.id.clone(),
            polygons: shape_to_polygons(&exclusion.shape)
                .map(|geometry| union_set(&geometry).polygons)
                .unwrap_or_default(),
        })
        .collect();
    ResolvedProblemGeometry {
        container,
        items,
        exclusions,
    }
}

fn region_geometries(parts: &[RegionPart]) -> Result<Vec<PolygonSet>, PackingError> {
    let mut local = Vec::with_capacity(parts.len());
    let mut rotated = Vec::with_capacity(parts.len());
    for part in parts {
        if !part.rotation_deg.is_finite() || !finite_point(part.translation) {
            return Err(PackingError::geometry(
                "container part transform must be finite",
            ));
        }
        if part
            .snap
            .as_ref()
            .is_some_and(|snap| !finite_point(snap.offset))
        {
            return Err(PackingError::geometry(
                "container snap offset must be finite",
            ));
        }
        let geometry = shape_to_polygons(&part.shape)?;
        rotated.push(transform(&geometry, part.rotation_deg, 0.0, 0.0));
        local.push(geometry);
    }
    let mut translations = vec![None; parts.len()];
    let mut active = vec![false; parts.len()];
    for index in 0..parts.len() {
        resolve_region_translation(index, parts, &local, &mut translations, &mut active)?;
    }
    Ok(rotated
        .into_iter()
        .zip(translations)
        .map(|(geometry, translation)| {
            let translation = translation.expect("every container translation was resolved");
            transform(&geometry, 0.0, translation.x, translation.y)
        })
        .collect())
}

fn resolve_region_translation(
    index: usize,
    parts: &[RegionPart],
    local: &[PolygonSet],
    translations: &mut [Option<Point>],
    active: &mut [bool],
) -> Result<Point, PackingError> {
    if let Some(translation) = translations[index] {
        return Ok(translation);
    }
    if active[index] {
        return Err(PackingError::config(
            "container snap relationships must not contain a cycle",
        ));
    }
    active[index] = true;
    let translation = if let Some(snap) = &parts[index].snap {
        if snap.target_part >= parts.len() {
            return Err(PackingError::config(format!(
                "container part {index} snaps to missing part {}",
                snap.target_part
            )));
        }
        if snap.target_part == index {
            return Err(PackingError::config(format!(
                "container part {index} cannot snap to itself"
            )));
        }
        let target_translation =
            resolve_region_translation(snap.target_part, parts, local, translations, active)?;
        let own_anchor = rotated_anchor(&local[index], parts[index].rotation_deg, snap.own_anchor);
        let mut target_anchor = rotated_anchor(
            &local[snap.target_part],
            parts[snap.target_part].rotation_deg,
            snap.target_anchor,
        );
        target_anchor.x += target_translation.x;
        target_anchor.y += target_translation.y;
        Point {
            x: target_anchor.x - own_anchor.x + snap.offset.x,
            y: target_anchor.y - own_anchor.y + snap.offset.y,
        }
    } else {
        parts[index].translation
    };
    active[index] = false;
    translations[index] = Some(translation);
    Ok(translation)
}

pub(crate) fn union_set(set: &PolygonSet) -> PolygonSet {
    set.polygons
        .iter()
        .fold(PolygonSet::new(Vec::new()), |result, contour| {
            overlay(
                &result,
                &PolygonSet::new(vec![contour.clone()]),
                OverlayRule::Union,
            )
        })
}

fn overlay(subject: &PolygonSet, clip: &PolygonSet, rule: OverlayRule) -> PolygonSet {
    if subject.polygons.is_empty() {
        return if rule == OverlayRule::Difference {
            subject.clone()
        } else {
            clip.clone()
        };
    }
    if clip.polygons.is_empty() {
        return subject.clone();
    }
    let subject_paths = to_overlay_paths(subject);
    let clip_paths = to_overlay_paths(clip);
    let shapes = subject_paths.overlay(&clip_paths, rule, FillRule::NonZero);
    PolygonSet::new(
        shapes
            .into_iter()
            .flat_map(|shape| shape.into_iter())
            .map(|path| {
                path.into_iter()
                    .map(|point| Point {
                        x: point[0],
                        y: point[1],
                    })
                    .collect()
            })
            .collect(),
    )
}

fn to_overlay_paths(set: &PolygonSet) -> Vec<Vec<[f64; 2]>> {
    set.polygons
        .iter()
        .map(|path| path.iter().map(|point| [point.x, point.y]).collect())
        .collect()
}
