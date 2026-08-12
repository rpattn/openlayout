use crate::clock::Clock;
use crate::geometry::{
    Bounds, PolygonSet, area, bounds, container_region, equivalent_geometry,
    guaranteed_occupied_area, shape_to_polygons, transform, union_set,
};
use crate::{Item, PackingError, PackingProblem, validate_problem};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct PreparedVariant {
    pub id: usize,
    pub item_index: usize,
    pub item_id: String,
    pub rotation_deg: f64,
    pub(crate) geometry: PolygonSet,
    pub(crate) bounds: Bounds,
    pub(crate) occupied_area: f64,
}

#[derive(Debug, Clone)]
pub struct PreparedProblem {
    pub problem: PackingProblem,
    pub variants: Vec<PreparedVariant>,
    pub variants_by_item: BTreeMap<String, Vec<usize>>,
    pub simple_upper_bound: Option<usize>,
    pub region_upper_bound: Option<usize>,
    pub projection_upper_bound: Option<usize>,
    pub preparation_ms: u64,
    pub minimum_item_area: f64,
    pub usable_area: f64,
    pub(crate) container: PolygonSet,
    pub(crate) container_bounds: Bounds,
    pub(crate) exclusions: Vec<PolygonSet>,
    pub(crate) container_contacts: Vec<crate::Point>,
    pub(crate) exclusion_contacts: Vec<crate::Point>,
}

pub fn prepare_problem(problem: &PackingProblem) -> Result<PreparedProblem, PackingError> {
    let started = Clock::start();
    validate_problem(problem)?;
    let container = container_region(&problem.container.parts)?;
    let container_bounds = bounds(&container);
    let exclusions = problem
        .exclusions
        .iter()
        .map(|entry| shape_to_polygons(&entry.shape).map(|geometry| union_set(&geometry)))
        .collect::<Result<Vec<_>, _>>()?;
    let container_contacts = boundary_contacts(&container);
    let exclusion_contacts = exclusions.iter().flat_map(boundary_contacts).collect();
    let mut variants = Vec::new();
    let mut variants_by_item = BTreeMap::new();
    for (item_index, item) in problem.items.iter().enumerate() {
        prepare_item(
            item_index,
            item,
            &container,
            &problem.fixed_placements,
            &mut variants,
            &mut variants_by_item,
        )?;
    }
    // The structural container and compound item solids are Boolean-normalized, so their areas
    // include disconnected components and subtract holes correctly. Exclusions remain omitted
    // from this deliberately loose but safe bound because they can overlap.
    let usable_area = area(&container);
    let minimum_item_area = variants
        .iter()
        .map(|variant| guaranteed_occupied_area(&variant.geometry))
        .fold(f64::INFINITY, f64::min);
    let quantity_total = problem
        .items
        .iter()
        .map(|item| item.quantity as u64)
        .sum::<u64>();
    let area_bound = if minimum_item_area.is_finite() {
        (usable_area / minimum_item_area).floor().max(0.0) as usize
    } else {
        0
    };
    let area_upper_bound = area_bound.min(quantity_total.min(usize::MAX as u64) as usize);
    // A connected item cannot occupy two disconnected container contours. Treating hole contours
    // as usable only loosens this sum, so it remains safe even though PolygonSet stores both kinds
    // of boundary in one list.
    let region_upper_bound = variants
        .iter()
        .all(|variant| variant.geometry.polygons.len() == 1)
        .then(|| {
            container
                .polygons
                .iter()
                .map(|polygon| {
                    let region = PolygonSet {
                        polygons: vec![polygon.clone()],
                    };
                    (area(&region) / minimum_item_area).floor().max(0.0) as usize
                })
                .sum::<usize>()
                .min(quantity_total.min(usize::MAX as u64) as usize)
        });
    // Projection pruning is enabled only when every prepared solid is its full axis-aligned
    // bounding rectangle. Every placement then occupies at least min_width by min_height in the
    // container bounding box; non-rectangular and rotated variants deliberately disable it.
    let projection_upper_bound = variants
        .iter()
        .all(|variant| is_axis_aligned_rectangle(&variant.geometry, variant.bounds))
        .then(|| {
            let min_width = variants
                .iter()
                .map(|variant| variant.bounds.width())
                .fold(f64::INFINITY, f64::min);
            let min_height = variants
                .iter()
                .map(|variant| variant.bounds.height())
                .fold(f64::INFINITY, f64::min);
            ((container_bounds.width() / min_width).floor().max(0.0) as usize)
                .saturating_mul((container_bounds.height() / min_height).floor().max(0.0) as usize)
                .min(quantity_total.min(usize::MAX as u64) as usize)
        });
    let simple_upper_bound = Some(
        [
            Some(area_upper_bound),
            region_upper_bound,
            projection_upper_bound,
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(area_upper_bound),
    );
    Ok(PreparedProblem {
        problem: problem.clone(),
        variants,
        variants_by_item,
        simple_upper_bound,
        region_upper_bound,
        projection_upper_bound,
        preparation_ms: started.elapsed_ms(),
        minimum_item_area,
        usable_area,
        container,
        container_bounds,
        exclusions,
        container_contacts,
        exclusion_contacts,
    })
}

fn boundary_contacts(set: &PolygonSet) -> Vec<crate::Point> {
    set.polygons
        .iter()
        .flat_map(|polygon| {
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
        })
        .collect()
}

fn is_axis_aligned_rectangle(geometry: &PolygonSet, geometry_bounds: Bounds) -> bool {
    if geometry.polygons.len() != 1 || geometry.polygons[0].len() != 4 {
        return false;
    }
    geometry.polygons[0].iter().all(|point| {
        ((point.x - geometry_bounds.min_x).abs() <= 1e-7
            || (point.x - geometry_bounds.max_x).abs() <= 1e-7)
            && ((point.y - geometry_bounds.min_y).abs() <= 1e-7
                || (point.y - geometry_bounds.max_y).abs() <= 1e-7)
    })
}

fn prepare_item(
    item_index: usize,
    item: &Item,
    container: &PolygonSet,
    fixed_placements: &[crate::FixedPlacement],
    variants: &mut Vec<PreparedVariant>,
    by_item: &mut BTreeMap<String, Vec<usize>>,
) -> Result<(), PackingError> {
    let base = union_set(&shape_to_polygons(&item.shape)?);
    let mut rotations = rotation_candidates(item, &base, container);
    rotations.extend(
        fixed_placements
            .iter()
            .filter(|fixed| fixed.item_id == item.id)
            .map(|fixed| fixed.rotation_deg),
    );
    rotations.sort_by(f64::total_cmp);
    rotations.dedup_by(|a, b| normalised_rotation(*a) == normalised_rotation(*b));
    for rotation in rotations {
        let rotation_deg = normalised_rotation(rotation);
        let geometry = transform(&base, rotation_deg, 0.0, 0.0);
        let geometry_bounds = bounds(&geometry);
        if variants.iter().any(|existing| {
            existing.item_index == item_index && equivalent_geometry(&existing.geometry, &geometry)
        }) {
            continue;
        }
        let index = variants.len();
        let occupied_area = guaranteed_occupied_area(&geometry);
        variants.push(PreparedVariant {
            id: index,
            item_index,
            item_id: item.id.clone(),
            rotation_deg,
            geometry,
            bounds: geometry_bounds,
            occupied_area,
        });
        by_item.entry(item.id.clone()).or_default().push(index);
    }
    Ok(())
}

fn rotation_candidates(
    item: &Item,
    item_geometry: &PolygonSet,
    container: &PolygonSet,
) -> Vec<f64> {
    match &item.rotation_policy {
        crate::RotationPolicy::Discrete { angles_deg, .. } => angles_deg.clone(),
        crate::RotationPolicy::Continuous {
            min_deg, max_deg, ..
        } => {
            let mut angles = Vec::new();
            let mut angle = *min_deg;
            while angle < *max_deg - 1e-9 && angles.len() < 24 {
                angles.push(angle);
                angle += 15.0;
            }
            let item_edges = edge_angles(item_geometry);
            let container_edges = edge_angles(container);
            let mut aligned = Vec::new();
            for (item_angle, item_length) in &item_edges {
                for (container_angle, container_length) in &container_edges {
                    let candidate = normalised_rotation(container_angle - item_angle);
                    if angle_in_range(candidate, *min_deg, *max_deg) {
                        aligned.push((item_length * container_length, candidate));
                    }
                }
            }
            aligned.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.total_cmp(&b.1)));
            let promising = aligned
                .into_iter()
                .map(|(_, angle)| angle)
                .take(8)
                .collect::<Vec<_>>();
            angles.extend(promising.iter().copied());
            for angle in promising.iter().take(4) {
                for refined in [angle - 2.5, angle + 2.5] {
                    let refined = normalised_rotation(refined);
                    if angle_in_range(refined, *min_deg, *max_deg) {
                        angles.push(refined);
                    }
                }
            }
            angles
        }
    }
}

fn edge_angles(set: &PolygonSet) -> Vec<(f64, f64)> {
    set.polygons
        .iter()
        .flat_map(|polygon| {
            (0..polygon.len()).map(|index| {
                let a = polygon[index];
                let b = polygon[(index + 1) % polygon.len()];
                (
                    (b.y - a.y).atan2(b.x - a.x).to_degrees(),
                    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt(),
                )
            })
        })
        .collect()
}

pub(crate) fn angle_in_range(angle: f64, min: f64, max: f64) -> bool {
    let span = max - min;
    if span >= 360.0 - 1e-9 {
        return true;
    }
    (normalised_rotation(angle) - normalised_rotation(min)).rem_euclid(360.0) <= span + 1e-9
}

fn normalised_rotation(value: f64) -> f64 {
    value.rem_euclid(360.0)
}
