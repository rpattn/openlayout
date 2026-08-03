use crate::geometry::{
    Bounds, EPSILON, PolygonSet, bounds, set_distance, set_inside, sets_overlap, transform,
};
use crate::{
    PackingError, PackingErrorKind, Placement, PreparedProblem, SolveOptions, SolveProgress,
    SolveResult, SolveStatistics, SolveStatus, ValidationReport, prepare_problem,
    validate_placements,
};
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;
use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant as NativeInstant;

#[cfg(not(target_arch = "wasm32"))]
type SolveInstant = NativeInstant;

#[cfg(target_arch = "wasm32")]
#[derive(Clone, Copy)]
struct SolveInstant;

pub trait SolveObserver {
    fn should_cancel(&mut self) -> bool {
        false
    }
    fn on_progress(&mut self, _progress: &SolveProgress) {}
}

struct NoObserver;
impl SolveObserver for NoObserver {}

#[derive(Default)]
struct Counters {
    evaluated: u64,
    valid: u64,
    iterations: u64,
    limit: bool,
    cancelled: bool,
}

#[derive(Clone)]
struct CandidatePlacement {
    placement: Placement,
    geometry: PolygonSet,
    bounds: Bounds,
}

pub fn solve(
    problem: &crate::PackingProblem,
    options: &SolveOptions,
) -> Result<SolveResult, PackingError> {
    let prepared = prepare_problem(problem)?;
    solve_prepared(&prepared, options)
}

pub fn solve_prepared(
    prepared: &PreparedProblem,
    options: &SolveOptions,
) -> Result<SolveResult, PackingError> {
    solve_with_observer(prepared, options, &mut NoObserver)
}

pub fn solve_with_observer(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
) -> Result<SolveResult, PackingError> {
    validate_options(options)?;
    let started = clock_start();
    let mut counters = Counters::default();
    let fixed = prepare_fixed(prepared)?;
    let mut best = fixed.clone();
    let mut best_strategy = "fixed_only".to_string();
    let variants = portfolio_orders(prepared, options.seed, options.restarts);
    for (strategy_index, (strategy, order, stagger, columns, alternating)) in
        variants.into_iter().enumerate()
    {
        if stop_requested(options, started, &mut counters, observer) {
            break;
        }
        let mut placements = fixed.clone();
        if alternating {
            alternating_fill(
                prepared,
                options,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
        } else {
            structured_fill(
                prepared,
                options,
                &order,
                stagger,
                columns,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
        }
        greedy_fill(
            prepared,
            options,
            &order,
            &mut placements,
            &mut counters,
            started,
            observer,
        );
        compact(
            prepared,
            options,
            &mut placements,
            &mut counters,
            started,
            observer,
        );
        if placements.len() > best.len()
            || (placements.len() == best.len() && layout_key(&placements) < layout_key(&best))
        {
            best = placements;
            best_strategy = format!("{strategy}+greedy+compact");
        }
        let progress = SolveProgress {
            iterations: counters.iterations,
            packed_item_count: best.len(),
            placements: best.iter().map(|entry| entry.placement.clone()).collect(),
            solver_strategy: best_strategy.clone(),
        };
        observer.on_progress(&progress);
        if strategy_index > 0 && Some(best.len()) == prepared.simple_upper_bound {
            break;
        }
    }
    let best_placements = best
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let validation = validate_placements(prepared, &best_placements)?;
    if !validation.valid {
        return Err(PackingError::validation(format!(
            "solver produced an invalid result: {}",
            validation.errors.join("; ")
        )));
    }
    let status = if counters.cancelled {
        SolveStatus::Cancelled
    } else if counters.limit {
        SolveStatus::LimitReached
    } else if Some(best.len()) == prepared.simple_upper_bound {
        SolveStatus::ProvenOptimal
    } else if best.is_empty() {
        SolveStatus::Infeasible
    } else {
        SolveStatus::BestFound
    };
    Ok(build_result(
        prepared,
        options,
        best,
        best_strategy,
        counters,
        started,
        validation,
        status,
    ))
}

fn validate_options(options: &SolveOptions) -> Result<(), PackingError> {
    if options.max_iterations == 0
        || !options.grid_step.is_finite()
        || options.grid_step <= 0.0
        || options.restarts == 0
    {
        return Err(PackingError::config(
            "solve options require positive iterations, grid step, and restart count",
        ));
    }
    if options.deterministic && options.time_limit_ms.is_some() {
        return Err(PackingError::config(
            "deterministic solving cannot use a wall-clock limit; use max_iterations or set deterministic to false",
        ));
    }
    #[cfg(target_arch = "wasm32")]
    if options.time_limit_ms.is_some() {
        return Err(PackingError::config(
            "Wasm solves use iteration limits; terminate the worker for wall-clock cancellation",
        ));
    }
    Ok(())
}

fn portfolio_orders(
    prepared: &PreparedProblem,
    seed: u64,
    restarts: u32,
) -> Vec<(String, Vec<usize>, bool, bool, bool)> {
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
    ));
    output.push((
        "structured_staggered".to_string(),
        base.clone(),
        true,
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
        by_height,
        false,
        true,
        false,
    ));
    output.push((
        "structured_alternating".to_string(),
        base.clone(),
        false,
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
        ));
    }
    output
}

fn alternating_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
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

fn prepare_fixed(prepared: &PreparedProblem) -> Result<Vec<CandidatePlacement>, PackingError> {
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

#[allow(clippy::too_many_arguments)]
fn structured_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    stagger: bool,
    columns: bool,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) {
    for &variant_index in order {
        let variant = &prepared.variants[variant_index];
        let pitch_x =
            variant.bounds.width() + prepared.problem.clearance.item_to_item + EPSILON * 10.0;
        let pitch_y =
            variant.bounds.height() + prepared.problem.clearance.item_to_item + EPSILON * 10.0;
        for origin_high in [false, true] {
            if columns {
                let mut column = 0usize;
                let mut x = prepared.container_bounds.min_x - variant.bounds.min_x
                    + prepared.problem.clearance.item_to_boundary;
                while x + variant.bounds.max_x <= prepared.container_bounds.max_x + EPSILON {
                    let offset = if stagger && column % 2 == 1 {
                        pitch_y / 2.0
                    } else {
                        0.0
                    };
                    let mut y = if origin_high {
                        prepared.container_bounds.max_y - variant.bounds.max_y - offset
                    } else {
                        prepared.container_bounds.min_y - variant.bounds.min_y + offset
                    };
                    loop {
                        if stop_requested(options, started, counters, observer) {
                            return;
                        }
                        let beyond = if origin_high {
                            y + variant.bounds.min_y < prepared.container_bounds.min_y - EPSILON
                        } else {
                            y + variant.bounds.max_y > prepared.container_bounds.max_y + EPSILON
                        };
                        if beyond {
                            break;
                        }
                        try_place(prepared, variant, x, y, placed, counters);
                        y += if origin_high { -pitch_y } else { pitch_y };
                    }
                    column += 1;
                    x += pitch_x;
                }
                continue;
            }
            let mut row = 0usize;
            let mut y = prepared.container_bounds.min_y - variant.bounds.min_y
                + prepared.problem.clearance.item_to_boundary;
            while y + variant.bounds.max_y <= prepared.container_bounds.max_y + EPSILON {
                let offset = if stagger && row % 2 == 1 {
                    pitch_x / 2.0
                } else {
                    0.0
                };
                let mut x = if origin_high {
                    prepared.container_bounds.max_x - variant.bounds.max_x - offset
                } else {
                    prepared.container_bounds.min_x - variant.bounds.min_x + offset
                };
                loop {
                    if stop_requested(options, started, counters, observer) {
                        return;
                    }
                    let beyond = if origin_high {
                        x + variant.bounds.min_x < prepared.container_bounds.min_x - EPSILON
                    } else {
                        x + variant.bounds.max_x > prepared.container_bounds.max_x + EPSILON
                    };
                    if beyond {
                        break;
                    }
                    try_place(prepared, variant, x, y, placed, counters);
                    x += if origin_high { -pitch_x } else { pitch_x };
                }
                row += 1;
                y += pitch_y;
            }
        }
    }
}

fn greedy_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) {
    let step = options.grid_step;
    for &variant_index in order {
        let variant = &prepared.variants[variant_index];
        let mut positions = contact_positions(prepared, variant, placed);
        let mut y = prepared.container_bounds.min_y - variant.bounds.min_y;
        while y + variant.bounds.max_y <= prepared.container_bounds.max_y + EPSILON {
            let mut x = prepared.container_bounds.min_x - variant.bounds.min_x;
            while x + variant.bounds.max_x <= prepared.container_bounds.max_x + EPSILON {
                positions.push((x, y));
                x += step;
            }
            y += step;
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

fn contact_positions(
    prepared: &PreparedProblem,
    variant: &crate::prepare::PreparedVariant,
    placed: &[CandidatePlacement],
) -> Vec<(f64, f64)> {
    let gap = prepared.problem.clearance.item_to_item + EPSILON * 10.0;
    let mut positions = vec![
        (
            prepared.container_bounds.min_x - variant.bounds.min_x,
            prepared.container_bounds.min_y - variant.bounds.min_y,
        ),
        (
            prepared.container_bounds.max_x - variant.bounds.max_x,
            prepared.container_bounds.min_y - variant.bounds.min_y,
        ),
        (
            prepared.container_bounds.min_x - variant.bounds.min_x,
            prepared.container_bounds.max_y - variant.bounds.max_y,
        ),
        (
            prepared.container_bounds.max_x - variant.bounds.max_x,
            prepared.container_bounds.max_y - variant.bounds.max_y,
        ),
    ];
    for existing in placed {
        positions.push((
            existing.bounds.max_x + gap - variant.bounds.min_x,
            existing.placement.y,
        ));
        positions.push((
            existing.bounds.min_x - gap - variant.bounds.max_x,
            existing.placement.y,
        ));
        positions.push((
            existing.placement.x,
            existing.bounds.max_y + gap - variant.bounds.min_y,
        ));
        positions.push((
            existing.placement.x,
            existing.bounds.min_y - gap - variant.bounds.max_y,
        ));
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

fn compact(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placed: &mut [CandidatePlacement],
    counters: &mut Counters,
    started: SolveInstant,
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
    if feasible(prepared, &next, placed.iter()) {
        counters.valid += 1;
        placed.push(next);
    }
}

fn feasible<'a>(
    prepared: &PreparedProblem,
    next: &CandidatePlacement,
    placed: impl Iterator<Item = &'a CandidatePlacement>,
) -> bool {
    if !set_inside(
        &next.geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    ) {
        return false;
    }
    for (index, exclusion) in prepared.exclusions.iter().enumerate() {
        let required = prepared
            .problem
            .clearance
            .item_to_exclusion
            .max(prepared.problem.exclusions[index].clearance);
        if next.bounds.overlaps(bounds(exclusion), required)
            && (sets_overlap(&next.geometry, exclusion)
                || set_distance(&next.geometry, exclusion) + EPSILON < required)
        {
            return false;
        }
    }
    for existing in placed {
        let required = prepared.problem.clearance.item_to_item;
        if next.bounds.overlaps(existing.bounds, required)
            && (sets_overlap(&next.geometry, &existing.geometry)
                || set_distance(&next.geometry, &existing.geometry) + EPSILON < required)
        {
            return false;
        }
    }
    true
}

fn candidate(
    variant: &crate::prepare::PreparedVariant,
    x: f64,
    y: f64,
    fixed: bool,
) -> CandidatePlacement {
    CandidatePlacement {
        placement: Placement {
            item_id: variant.item_id.clone(),
            x,
            y,
            rotation_deg: variant.rotation_deg,
            fixed,
        },
        geometry: transform(&variant.geometry, 0.0, x, y),
        bounds: variant.bounds.translated(x, y),
    }
}

fn stop_requested(
    options: &SolveOptions,
    started: SolveInstant,
    counters: &mut Counters,
    observer: &mut dyn SolveObserver,
) -> bool {
    if counters.iterations >= options.max_iterations {
        counters.limit = true;
        return true;
    }
    if !options.deterministic
        && options
            .time_limit_ms
            .is_some_and(|limit| elapsed_ms(started) >= limit)
    {
        counters.limit = true;
        return true;
    }
    if counters.iterations.is_multiple_of(256) && observer.should_cancel() {
        counters.cancelled = true;
        return true;
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn build_result(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    entries: Vec<CandidatePlacement>,
    strategy: String,
    counters: Counters,
    started: SolveInstant,
    validation: ValidationReport,
    status: SolveStatus,
) -> SolveResult {
    let placements = entries
        .into_iter()
        .map(|entry| entry.placement)
        .collect::<Vec<_>>();
    let mut counts = BTreeMap::new();
    for placement in &placements {
        *counts.entry(placement.item_id.clone()).or_default() += 1;
    }
    SolveResult {
        layout_id: layout_id(prepared, options, &placements),
        status,
        packed_item_count: placements.len(),
        objective_score: placements.len() as f64,
        placements,
        packed_count_by_item: counts,
        simple_upper_bound: prepared.simple_upper_bound,
        seed: options.seed,
        solver_strategy: strategy,
        statistics: SolveStatistics {
            candidates_evaluated: counters.evaluated,
            valid_candidates: counters.valid,
            iterations: counters.iterations,
            elapsed_ms: elapsed_ms(started),
        },
        validation,
        warnings: Vec::new(),
    }
}

fn layout_id(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placements: &[Placement],
) -> String {
    let bytes = serde_json::to_vec(&(prepared.problem.clone(), options, placements))
        .expect("validated packing data is serializable");
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("layout-{hash:016x}")
}

#[cfg(not(target_arch = "wasm32"))]
fn clock_start() -> SolveInstant {
    NativeInstant::now()
}

#[cfg(target_arch = "wasm32")]
fn clock_start() -> SolveInstant {
    SolveInstant
}

#[cfg(not(target_arch = "wasm32"))]
fn elapsed_ms(started: SolveInstant) -> u64 {
    started.elapsed().as_millis() as u64
}

// Browser workers own cancellation and timing. Keeping the core clock-free on this target avoids
// requiring browser APIs in packing-core and preserves deterministic iteration-bounded results.
#[cfg(target_arch = "wasm32")]
fn elapsed_ms(_started: SolveInstant) -> u64 {
    0
}

fn item_count(placed: &[CandidatePlacement], item_id: &str) -> usize {
    placed
        .iter()
        .filter(|entry| entry.placement.item_id == item_id)
        .count()
}
fn same_rotation(a: f64, b: f64) -> bool {
    (a - b).rem_euclid(360.0).min((b - a).rem_euclid(360.0)) < EPSILON
}
fn layout_key(entries: &[CandidatePlacement]) -> Vec<(String, u64, u64, u64)> {
    entries
        .iter()
        .map(|entry| {
            (
                entry.placement.item_id.clone(),
                entry.placement.x.to_bits(),
                entry.placement.y.to_bits(),
                entry.placement.rotation_deg.to_bits(),
            )
        })
        .collect()
}
