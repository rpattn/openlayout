use crate::geometry::{
    Bounds, PolygonSet, area, bounds, equivalent_geometry, guaranteed_occupied_area,
    shape_to_polygons, transform,
};
use crate::{Item, PackingError, PackingProblem, validate_problem};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct PreparedVariant {
    pub item_index: usize,
    pub item_id: String,
    pub rotation_deg: f64,
    pub(crate) geometry: PolygonSet,
    pub(crate) bounds: Bounds,
}

#[derive(Debug, Clone)]
pub struct PreparedProblem {
    pub problem: PackingProblem,
    pub variants: Vec<PreparedVariant>,
    pub variants_by_item: BTreeMap<String, Vec<usize>>,
    pub simple_upper_bound: Option<usize>,
    pub(crate) container: PolygonSet,
    pub(crate) container_bounds: Bounds,
    pub(crate) exclusions: Vec<PolygonSet>,
}

pub fn prepare_problem(problem: &PackingProblem) -> Result<PreparedProblem, PackingError> {
    validate_problem(problem)?;
    let container = shape_to_polygons(&problem.container.boundary)?;
    if container.polygons.len() != 1 {
        return Err(PackingError::geometry(
            "container boundary must resolve to one polygon",
        ));
    }
    let container_bounds = bounds(&container);
    let exclusions = problem
        .exclusions
        .iter()
        .map(|entry| shape_to_polygons(&entry.shape))
        .collect::<Result<Vec<_>, _>>()?;
    let mut variants = Vec::new();
    let mut variants_by_item = BTreeMap::new();
    for (item_index, item) in problem.items.iter().enumerate() {
        prepare_item(item_index, item, &mut variants, &mut variants_by_item)?;
    }
    // Container area without exclusion subtraction is deliberately loose but remains a valid
    // bound even when exclusions overlap. The largest compound component is a safe lower bound
    // on occupied area without requiring polygon union solely for this diagnostic.
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
    let simple_upper_bound = Some(area_bound.min(quantity_total.min(usize::MAX as u64) as usize));
    Ok(PreparedProblem {
        problem: problem.clone(),
        variants,
        variants_by_item,
        simple_upper_bound,
        container,
        container_bounds,
        exclusions,
    })
}

fn prepare_item(
    item_index: usize,
    item: &Item,
    variants: &mut Vec<PreparedVariant>,
    by_item: &mut BTreeMap<String, Vec<usize>>,
) -> Result<(), PackingError> {
    let base = shape_to_polygons(&item.shape)?;
    let mut rotations = item.rotations.clone();
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
        variants.push(PreparedVariant {
            item_index,
            item_id: item.id.clone(),
            rotation_deg,
            geometry,
            bounds: geometry_bounds,
        });
        by_item.entry(item.id.clone()).or_default().push(index);
    }
    Ok(())
}

fn normalised_rotation(value: f64) -> f64 {
    value.rem_euclid(360.0)
}
