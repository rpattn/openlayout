use crate::geometry::{
    Bounds, EPSILON, PolygonSet, area, bounds, set_distance, set_inside, sets_overlap, transform,
};
use crate::search::{SearchMetrics, bounded_search};
use crate::{
    PackingError, PackingErrorKind, Placement, PreparedProblem, SolveOptions, SolvePhase,
    SolveProgress, SolveResult, SolveStatistics, SolveStatus, ValidationReport, prepare_problem,
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
    search: SearchMetrics,
    greedy_lower_bound: usize,
    local_improvement_attempts: u64,
    local_improvements_accepted: u64,
    overlap_repair_attempts: u64,
    overlap_repair_evaluated_moves: u64,
    overlap_repair_accepted_moves: u64,
    overlap_repair_weight_updates: u64,
    overlap_repair_successes: u64,
    overlap_repair_best_penalty: Option<f64>,
    failed_constructive_candidates: Vec<Placement>,
    continuation_stages: u64,
    continuation_repair_only_stages: u64,
    continuation_search_stages: u64,
    continuation_full_solve_stages: u64,
    warm_start_status: crate::WarmStartStatus,
    containment_check_ms: u64,
    collision_check_ms: u64,
    subdivision_ms: u64,
    broad_phase_rejections: u64,
    exact_geometry_checks: u64,
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

pub fn solve_prepared_with_warm_start(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placements: &[Placement],
) -> Result<SolveResult, PackingError> {
    solve_with_observer_internal(prepared, options, &mut NoObserver, Some(placements), true)
}

pub fn solve_prepared_direct(
    prepared: &PreparedProblem,
    options: &SolveOptions,
) -> Result<SolveResult, PackingError> {
    solve_with_observer_direct(prepared, options, &mut NoObserver)
}

pub fn solve_prepared_clearance_continuation(
    prepared: &PreparedProblem,
    options: &SolveOptions,
) -> Result<SolveResult, PackingError> {
    solve_with_observer_clearance_continuation(prepared, options, &mut NoObserver)
}

pub fn solve_feasibility(
    problem: &crate::PackingProblem,
    options: &SolveOptions,
    target_count: usize,
) -> Result<crate::FeasibilityResult, PackingError> {
    let prepared = prepare_problem(problem)?;
    solve_prepared_feasibility(&prepared, options, target_count)
}

pub fn solve_prepared_feasibility(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    target_count: usize,
) -> Result<crate::FeasibilityResult, PackingError> {
    validate_options(options)?;
    if prepared
        .simple_upper_bound
        .is_some_and(|upper| upper < target_count)
    {
        return Ok(crate::FeasibilityResult {
            status: crate::FeasibilityStatus::ImpossibleByBound,
            target_count,
            result: None,
            valid_upper_bound: prepared.simple_upper_bound,
        });
    }
    let started = clock_start();
    let fixed = prepare_fixed(prepared)?;
    let fixed_placements = fixed
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let mut search_options = *options;
    if search_options.quality == crate::SolveQuality::Fast {
        search_options.quality = crate::SolveQuality::Balanced;
    }
    let Some(outcome) = bounded_search(
        prepared,
        &search_options,
        &fixed_placements,
        Some(target_count),
        &mut NoObserver,
    ) else {
        unreachable!("feasibility search always enables a bounded beam")
    };
    if outcome.placements.len() < target_count {
        return Ok(crate::FeasibilityResult {
            status: crate::FeasibilityStatus::NotFoundWithinLimit,
            target_count,
            result: None,
            valid_upper_bound: Some(outcome.upper_bound),
        });
    }
    let entries = candidate_entries_from_placements(prepared, &outcome.placements)?;
    let validation = validate_placements(prepared, &outcome.placements)?;
    if !validation.valid {
        return Err(PackingError::validation(
            "feasibility search produced an invalid layout",
        ));
    }
    let counters = Counters {
        search: outcome.metrics,
        greedy_lower_bound: fixed.len(),
        ..Counters::default()
    };
    let result = build_result(
        prepared,
        options,
        entries,
        outcome.strategy,
        counters,
        started,
        validation,
        SolveStatus::Feasible,
    );
    Ok(crate::FeasibilityResult {
        status: crate::FeasibilityStatus::Feasible,
        target_count,
        valid_upper_bound: Some(outcome.upper_bound),
        result: Some(result),
    })
}

pub fn solve_with_observer(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
) -> Result<SolveResult, PackingError> {
    solve_with_observer_internal(prepared, options, observer, None, true)
}

pub fn solve_with_observer_direct(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
) -> Result<SolveResult, PackingError> {
    solve_with_observer_internal(prepared, options, observer, None, false)
}

pub fn solve_with_observer_clearance_continuation(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
) -> Result<SolveResult, PackingError> {
    validate_options(options)?;
    if options.quality == crate::SolveQuality::Fast
        || options.max_iterations < 40_000
        || prepared.problem.items.len() != 1
        || prepared.problem.clearance.item_to_item <= EPSILON
    {
        return solve_with_observer_direct(prepared, options, observer);
    }
    let started = clock_start();
    let fixed = prepare_fixed(prepared)?;
    let fixed_placements = fixed
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let continuation = clearance_continuation(prepared, options, observer, &fixed_placements)?;
    let mut counters = Counters {
        continuation_stages: continuation.stages,
        continuation_repair_only_stages: continuation.repair_only_stages,
        continuation_search_stages: continuation.search_stages,
        continuation_full_solve_stages: continuation.full_solve_stages,
        warm_start_status: crate::WarmStartStatus::PartiallyRepaired,
        ..Counters::default()
    };
    let best = repair_warm_start(prepared, &fixed, &continuation.placements);
    counters.greedy_lower_bound = best.len();
    let placements = best
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    observer.on_progress(&SolveProgress {
        phase: SolvePhase::Validating,
        completed_fraction: 1.0,
        max_iterations: options.max_iterations,
        iterations: 0,
        packed_item_count: placements.len(),
        placements: placements.clone(),
        solver_strategy: "clearance_continuation".to_string(),
    });
    let validation = validate_placements(prepared, &placements)?;
    if !validation.valid {
        return Err(PackingError::validation(format!(
            "clearance continuation produced an invalid result: {}",
            validation.errors.join("; ")
        )));
    }
    let status = if Some(best.len()) == prepared.simple_upper_bound {
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
        "clearance_continuation".to_string(),
        counters,
        started,
        validation,
        status,
    ))
}

fn solve_with_observer_internal(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
    warm_start: Option<&[Placement]>,
    allow_continuation: bool,
) -> Result<SolveResult, PackingError> {
    validate_options(options)?;
    let mut run_options = *options;
    run_options.max_iterations = effective_iteration_budget(options);
    let started = clock_start();
    let mut counters = Counters::default();
    let fixed = prepare_fixed(prepared)?;
    let mut best = fixed.clone();
    let mut best_strategy = "fixed_only".to_string();
    if let Some(placements) = warm_start {
        let repaired = repair_warm_start(prepared, &fixed, placements);
        if repaired.len() > fixed.len() {
            counters.warm_start_status = if repaired.len() == placements.len() {
                crate::WarmStartStatus::Retained
            } else {
                crate::WarmStartStatus::PartiallyRepaired
            };
            best = repaired;
            best_strategy = "warm_start".to_string();
        } else {
            counters.warm_start_status = crate::WarmStartStatus::Restarted;
        }
    }
    if best.len() > fixed.len() {
        let mut repaired = best.clone();
        let order = (0..prepared.variants.len()).collect::<Vec<_>>();
        let mut repair_options = run_options;
        repair_options.max_iterations = (run_options.max_iterations / 10).max(1);
        greedy_fill(
            prepared,
            &repair_options,
            &order,
            &mut repaired,
            &mut counters,
            started,
            observer,
        );
        if repaired.len() > best.len()
            || (repaired.len() == best.len() && layout_key(&repaired) < layout_key(&best))
        {
            best = repaired;
            best_strategy = "warm_start+repair".to_string();
        }
        clear_local_limit(&mut counters, &run_options);
    }
    let mut learning_options = run_options;
    learning_options.max_iterations = (run_options.max_iterations.saturating_mul(25) / 100).max(1);
    for (strategy, placements) in learned_lattice_layouts(
        prepared,
        &learning_options,
        &fixed,
        &mut counters,
        started,
        observer,
    ) {
        if placements.len() > best.len()
            || (placements.len() == best.len() && layout_key(&placements) < layout_key(&best))
        {
            best = placements;
            best_strategy = strategy;
        }
    }
    clear_local_limit(&mut counters, &run_options);
    learning_options.max_iterations = (run_options.max_iterations.saturating_mul(40) / 100)
        .max(counters.iterations + 1)
        .min(run_options.max_iterations);
    for (strategy, placements) in learned_motif_layouts(
        prepared,
        &learning_options,
        &fixed,
        &mut counters,
        started,
        observer,
    ) {
        if placements.len() > best.len()
            || (placements.len() == best.len() && layout_key(&placements) < layout_key(&best))
        {
            best = placements;
            best_strategy = strategy;
        }
    }
    clear_local_limit(&mut counters, &run_options);
    let requested_count = prepared
        .problem
        .items
        .iter()
        .map(|item| item.quantity as usize)
        .sum::<usize>();
    if prepared.problem.items.len() == 1 && best.len() < requested_count {
        let count_before = best.len();
        let order = completion_variant_order(prepared, &best);
        let mut completion_options = run_options;
        completion_options.max_iterations = (counters.iterations
            + run_options.max_iterations.saturating_mul(10) / 100)
            .min(run_options.max_iterations);
        contact_fill(
            prepared,
            &completion_options,
            &order,
            &mut best,
            &mut counters,
            started,
            observer,
        );
        if best.len() > count_before {
            best_strategy.push_str("+contact_fill");
        }
        clear_local_limit(&mut counters, &run_options);
    }
    observer.on_progress(&SolveProgress {
        phase: SolvePhase::Baseline,
        completed_fraction: (counters.iterations as f64 / run_options.max_iterations as f64)
            .clamp(0.0, 1.0),
        max_iterations: run_options.max_iterations,
        iterations: counters.iterations,
        packed_item_count: best.len(),
        placements: best.iter().map(|entry| entry.placement.clone()).collect(),
        solver_strategy: best_strategy.clone(),
    });
    if options.baseline_only {
        counters.greedy_lower_bound = best.len();
        return finalize_solve(
            prepared,
            options,
            &run_options,
            best,
            best_strategy,
            counters,
            started,
            observer,
        );
    }
    let effective_restarts = match options.quality {
        crate::SolveQuality::Fast => options.restarts.min(2),
        crate::SolveQuality::Balanced => options.restarts,
        crate::SolveQuality::Thorough => options.restarts.max(6),
    };
    let variants = portfolio_orders(prepared, options.seed, effective_restarts);
    let portfolio_count = variants.len();
    for (strategy_index, (strategy, order, stagger, columns, alternating, cross_high)) in
        variants.into_iter().enumerate()
    {
        if stop_requested(&run_options, started, &mut counters, observer) {
            break;
        }
        let remaining_attempts = (portfolio_count - strategy_index) as u64;
        let remaining_budget = run_options.max_iterations - counters.iterations;
        let attempt_budget = remaining_budget.div_ceil(remaining_attempts);
        let attempt_start = counters.iterations;
        let structured_end = attempt_start + attempt_budget.saturating_mul(30) / 100;
        let greedy_end = attempt_start + attempt_budget.saturating_mul(85) / 100;
        let compact_end = attempt_start + attempt_budget.saturating_mul(90) / 100;
        let compact_refill_end = attempt_start + attempt_budget.saturating_mul(92) / 100;
        let rotate_end = attempt_start + attempt_budget.saturating_mul(95) / 100;
        let rotate_refill_end = attempt_start + attempt_budget.saturating_mul(97) / 100;
        let attempt_end = (attempt_start + attempt_budget).min(run_options.max_iterations);
        let mut phase_options = run_options;
        phase_options.max_iterations = structured_end
            .max(counters.iterations + 1)
            .min(run_options.max_iterations);
        let mut placements = fixed.clone();
        if alternating {
            alternating_fill(
                prepared,
                &phase_options,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
        } else {
            structured_fill(
                prepared,
                &phase_options,
                &order,
                stagger,
                columns,
                cross_high,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
        }
        clear_local_limit(&mut counters, &run_options);
        phase_options.max_iterations = greedy_end
            .max(counters.iterations + 1)
            .min(run_options.max_iterations);
        greedy_fill(
            prepared,
            &phase_options,
            &order,
            &mut placements,
            &mut counters,
            started,
            observer,
        );
        clear_local_limit(&mut counters, &run_options);
        phase_options.max_iterations = compact_end
            .max(counters.iterations + 1)
            .min(run_options.max_iterations);
        compact(
            prepared,
            &phase_options,
            &mut placements,
            &mut counters,
            started,
            observer,
        );
        // Compaction changes the free-space arrangement. Close the incumbent under cheap
        // contact insertion before spending the next slice of the budget on rotations. Without
        // this pass, an obvious gap opened by compaction remains empty until destroy/reinsert or
        // the later beam search happens to reconstruct it.
        clear_local_limit(&mut counters, &run_options);
        phase_options.max_iterations = compact_refill_end
            .max(counters.iterations + 1)
            .min(run_options.max_iterations);
        contact_fill(
            prepared,
            &phase_options,
            &order,
            &mut placements,
            &mut counters,
            started,
            observer,
        );
        let mut neighbourhood_improved = false;
        if options.quality != crate::SolveQuality::Fast {
            clear_local_limit(&mut counters, &run_options);
            phase_options.max_iterations = rotate_end
                .max(counters.iterations + 1)
                .min(run_options.max_iterations);
            rotate_and_compact(
                prepared,
                &phase_options,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
            clear_local_limit(&mut counters, &run_options);
            phase_options.max_iterations = rotate_refill_end
                .max(counters.iterations + 1)
                .min(run_options.max_iterations);
            contact_fill(
                prepared,
                &phase_options,
                &order,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
            clear_local_limit(&mut counters, &run_options);
            phase_options.max_iterations = attempt_end
                .max(counters.iterations + 1)
                .min(run_options.max_iterations);
            counters.local_improvement_attempts += 1;
            neighbourhood_improved = remove_reinsert(
                prepared,
                &phase_options,
                &order,
                &mut placements,
                &mut counters,
                started,
                observer,
            );
            if neighbourhood_improved {
                counters.local_improvements_accepted += 1;
            }
        }
        if placements.len() > best.len()
            || (placements.len() == best.len() && layout_key(&placements) < layout_key(&best))
        {
            best = placements;
            best_strategy = if neighbourhood_improved {
                format!("{strategy}+greedy+compact+reinsert")
            } else {
                format!("{strategy}+greedy+compact")
            };
        }
        let progress = SolveProgress {
            phase: if strategy_index == 0 {
                SolvePhase::Baseline
            } else if strategy_index + 2 < portfolio_count {
                SolvePhase::CoarseRotation
            } else {
                SolvePhase::AngleRefinement
            },
            completed_fraction: (counters.iterations as f64 / run_options.max_iterations as f64)
                .clamp(0.0, 1.0),
            max_iterations: run_options.max_iterations,
            iterations: counters.iterations,
            packed_item_count: best.len(),
            placements: best.iter().map(|entry| entry.placement.clone()).collect(),
            solver_strategy: best_strategy.clone(),
        };
        observer.on_progress(&progress);
        if options.quality != crate::SolveQuality::Fast {
            observer.on_progress(&SolveProgress {
                phase: SolvePhase::NeighbourhoodImprovement,
                ..progress
            });
        }
        if strategy_index > 0 && Some(best.len()) == prepared.simple_upper_bound {
            break;
        }
        clear_local_limit(&mut counters, &run_options);
    }
    if options.quality != crate::SolveQuality::Fast
        && best.len() < requested_count
        && prepared
            .simple_upper_bound
            .is_none_or(|upper| best.len() < upper)
        && (options.deterministic
            || options
                .time_limit_ms
                .is_none_or(|limit| elapsed_ms(started) < limit))
    {
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::OverlapRepair,
            completed_fraction: 0.0,
            max_iterations: run_options.max_iterations,
            iterations: counters.iterations,
            packed_item_count: best.len(),
            placements: best.iter().map(|entry| entry.placement.clone()).collect(),
            solver_strategy: "overlap_repair".to_string(),
        });
        let incumbent = best
            .iter()
            .map(|entry| entry.placement.clone())
            .collect::<Vec<_>>();
        let mut repair_options = *options;
        if !options.deterministic {
            repair_options.time_limit_ms = options
                .time_limit_ms
                .map(|limit| limit.saturating_sub(elapsed_ms(started)));
        }
        let repair = crate::overlap::repair_one_more(
            prepared,
            &repair_options,
            &incumbent,
            &counters.failed_constructive_candidates,
            observer,
        );
        counters.overlap_repair_attempts += repair.metrics.attempts;
        counters.overlap_repair_evaluated_moves += repair.metrics.evaluated_moves;
        counters.overlap_repair_accepted_moves += repair.metrics.accepted_moves;
        counters.overlap_repair_weight_updates += repair.metrics.weight_updates;
        counters.overlap_repair_successes += repair.metrics.successful_repairs;
        counters.overlap_repair_best_penalty = match (
            counters.overlap_repair_best_penalty,
            repair.metrics.best_penalty,
        ) {
            (Some(current), Some(next)) => Some(current.min(next)),
            (current, next) => current.or(next),
        };
        counters.exact_geometry_checks += repair.metrics.exact_geometry_checks;
        counters.cancelled |= repair.metrics.cancelled;
        counters.limit |= repair.metrics.limit_reached;
        if let Some(placements) = repair.placements {
            let repaired = candidate_entries_from_placements(prepared, &placements)?;
            if repaired.len() > best.len()
                || (repaired.len() == best.len() && layout_key(&repaired) < layout_key(&best))
            {
                best = repaired;
                best_strategy = "overlap_repair".to_string();
            }
        }
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::OverlapRepair,
            completed_fraction: 1.0,
            max_iterations: run_options.max_iterations,
            iterations: counters.iterations,
            packed_item_count: best.len(),
            placements: best.iter().map(|entry| entry.placement.clone()).collect(),
            solver_strategy: best_strategy.clone(),
        });
    }
    if allow_continuation
        && warm_start.is_none()
        && options.quality != crate::SolveQuality::Fast
        && options.max_iterations >= 40_000
        && prepared.problem.items.len() == 1
        && prepared.problem.items[0].quantity as usize > best.len()
        && prepared.problem.clearance.item_to_item > EPSILON
    {
        let preview_seed = best
            .iter()
            .map(|entry| entry.placement.clone())
            .collect::<Vec<_>>();
        let continuation = clearance_continuation(prepared, options, observer, &preview_seed)?;
        counters.continuation_stages += continuation.stages;
        counters.continuation_repair_only_stages += continuation.repair_only_stages;
        counters.continuation_search_stages += continuation.search_stages;
        counters.continuation_full_solve_stages += continuation.full_solve_stages;
        let repaired = repair_warm_start(prepared, &fixed, &continuation.placements);
        if repaired.len() > best.len()
            || (repaired.len() == best.len() && layout_key(&repaired) < layout_key(&best))
        {
            best = repaired;
            best_strategy = "clearance_continuation".to_string();
            counters.warm_start_status = crate::WarmStartStatus::PartiallyRepaired;
        }
    }
    counters.greedy_lower_bound = best.len();
    let baseline_placements = best
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    if let Some(outcome) =
        bounded_search(prepared, &run_options, &baseline_placements, None, observer)
    {
        counters.search = outcome.metrics;
        counters.cancelled |= counters.search.cancelled;
        counters.limit |= counters.search.limit_reached;
        if outcome.placements.len() > best.len()
            || (outcome.placements.len() == best.len()
                && placement_layout_key(&outcome.placements)
                    < placement_layout_key(&baseline_placements))
        {
            best = candidate_entries_from_placements(prepared, &outcome.placements)?;
            best_strategy = outcome.strategy;
        }
    }
    finalize_solve(
        prepared,
        options,
        &run_options,
        best,
        best_strategy,
        counters,
        started,
        observer,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_solve(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    run_options: &SolveOptions,
    best: Vec<CandidatePlacement>,
    best_strategy: String,
    counters: Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) -> Result<SolveResult, PackingError> {
    let best_placements = best
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    observer.on_progress(&SolveProgress {
        phase: SolvePhase::Validating,
        completed_fraction: 1.0,
        max_iterations: run_options.max_iterations,
        iterations: counters.iterations,
        packed_item_count: best_placements.len(),
        placements: best_placements.clone(),
        solver_strategy: best_strategy.clone(),
    });
    let validation = validate_placements(prepared, &best_placements)?;
    if !validation.valid {
        return Err(PackingError::validation(format!(
            "solver produced an invalid result: {}",
            validation.errors.join("; ")
        )));
    }
    let status = if counters.cancelled {
        SolveStatus::Cancelled
    } else if Some(best.len()) == prepared.simple_upper_bound {
        SolveStatus::ProvenOptimal
    } else if counters.limit {
        SolveStatus::LimitReached
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

fn clearance_continuation(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
    preview_seed: &[Placement],
) -> Result<ContinuationOutcome, PackingError> {
    let target_clearance = prepared.problem.clearance.item_to_item;
    let origin_x = (prepared.container_bounds.min_x + prepared.container_bounds.max_x) / 2.0;
    let origin_y = (prepared.container_bounds.min_y + prepared.container_bounds.max_y) / 2.0;
    let centered = centered_prepared_problem(prepared, origin_x, origin_y);
    let mut preview = preview_seed.to_vec();
    let mut donor = Vec::new();
    let mut repair_only_stages = 0;
    let mut search_stages = 0;
    let mut full_solve_stages = 0;
    let mut continuation_options = *options;
    continuation_options.quality = crate::SolveQuality::Thorough;
    continuation_options.max_iterations = (options.max_iterations / 2).max(2_000);
    continuation_options.restarts = continuation_options.restarts.min(2);
    continuation_options.beam_width = Some(4);
    continuation_options.max_candidates_per_state = Some(8);
    continuation_options.max_search_states = Some(
        continuation_options
            .max_iterations
            .saturating_div(4)
            .max(128),
    );
    let fractions = [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
    for (stage, fraction) in fractions.into_iter().enumerate() {
        let mut relaxed_prepared = centered.clone();
        relaxed_prepared.problem.clearance.item_to_item = target_clearance * fraction;
        donor = if donor.is_empty() {
            full_solve_stages += 1;
            solve_with_observer_internal(
                &relaxed_prepared,
                &continuation_options,
                &mut NoObserver,
                Some(&donor),
                false,
            )?
            .placements
        } else {
            let outcome =
                incremental_clearance_stage(&relaxed_prepared, &continuation_options, &donor)?;
            match outcome.kind {
                ContinuationStageKind::RepairOnly => repair_only_stages += 1,
                ContinuationStageKind::Search => search_stages += 1,
                ContinuationStageKind::FullSolve => full_solve_stages += 1,
            }
            outcome.placements
        };
        let translated = donor
            .iter()
            .cloned()
            .map(|mut placement| {
                placement.x += origin_x;
                placement.y += origin_y;
                placement
            })
            .collect::<Vec<_>>();
        // Relaxed-stage layouts are valid only for their temporary clearance and must never be
        // rendered against the requested problem. The final stage uses the requested clearance;
        // its solver path has already validated the translated-equivalent geometry.
        if stage + 1 == fractions.len() {
            preview = translated;
        }
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::ClearanceContinuation,
            completed_fraction: (stage + 1) as f64 / fractions.len() as f64,
            max_iterations: continuation_options.max_iterations,
            iterations: 0,
            packed_item_count: preview.len(),
            placements: preview.clone(),
            solver_strategy: "clearance_continuation".to_string(),
        });
    }
    for placement in &mut donor {
        placement.x += origin_x;
        placement.y += origin_y;
    }
    Ok(ContinuationOutcome {
        placements: donor,
        stages: fractions.len() as u64,
        repair_only_stages,
        search_stages,
        full_solve_stages,
    })
}

struct ContinuationOutcome {
    placements: Vec<Placement>,
    stages: u64,
    repair_only_stages: u64,
    search_stages: u64,
    full_solve_stages: u64,
}

enum ContinuationStageKind {
    RepairOnly,
    Search,
    FullSolve,
}

struct ContinuationStageOutcome {
    placements: Vec<Placement>,
    kind: ContinuationStageKind,
}

fn incremental_clearance_stage(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    donor: &[Placement],
) -> Result<ContinuationStageOutcome, PackingError> {
    let target_count = donor.len();
    let fixed = prepare_fixed(prepared)?;
    let repaired = repair_warm_start(prepared, &fixed, donor);
    if repaired.len() >= target_count {
        return Ok(ContinuationStageOutcome {
            placements: repaired.into_iter().map(|entry| entry.placement).collect(),
            kind: ContinuationStageKind::RepairOnly,
        });
    }
    let baseline = repaired
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let mut search_options = *options;
    search_options.max_search_states = Some(512);
    if let Some(outcome) = bounded_search(
        prepared,
        &search_options,
        &baseline,
        Some(target_count),
        &mut NoObserver,
    ) && outcome.placements.len() > baseline.len()
    {
        return Ok(ContinuationStageOutcome {
            placements: outcome.placements,
            kind: ContinuationStageKind::Search,
        });
    }
    let mut fallback_options = *options;
    fallback_options.max_iterations = (options.max_iterations.saturating_mul(3) / 4).max(2_000);
    Ok(ContinuationStageOutcome {
        placements: solve_with_observer_internal(
            prepared,
            &fallback_options,
            &mut NoObserver,
            Some(donor),
            false,
        )?
        .placements,
        kind: ContinuationStageKind::FullSolve,
    })
}

fn centered_prepared_problem(
    prepared: &PreparedProblem,
    origin_x: f64,
    origin_y: f64,
) -> PreparedProblem {
    let mut centered = prepared.clone();
    centered.container = transform(&centered.container, 0.0, -origin_x, -origin_y);
    centered.container_bounds = centered.container_bounds.translated(-origin_x, -origin_y);
    centered.exclusions = centered
        .exclusions
        .iter()
        .map(|geometry| transform(geometry, 0.0, -origin_x, -origin_y))
        .collect();
    for point in &mut centered.container_contacts {
        point.x -= origin_x;
        point.y -= origin_y;
    }
    for point in &mut centered.exclusion_contacts {
        point.x -= origin_x;
        point.y -= origin_y;
    }
    for part in &mut centered.problem.container.parts {
        part.translation.x -= origin_x;
        part.translation.y -= origin_y;
    }
    for placement in &mut centered.problem.fixed_placements {
        placement.x -= origin_x;
        placement.y -= origin_y;
    }
    centered
}

fn effective_iteration_budget(options: &SolveOptions) -> u64 {
    let multiplier = match options.quality {
        crate::SolveQuality::Fast | crate::SolveQuality::Balanced => 1,
        crate::SolveQuality::Thorough => 4,
    };
    options.max_iterations.saturating_mul(multiplier)
}

fn clear_local_limit(counters: &mut Counters, global_options: &SolveOptions) {
    if !counters.cancelled && counters.iterations < global_options.max_iterations {
        counters.limit = false;
    }
}

fn validate_options(options: &SolveOptions) -> Result<(), PackingError> {
    if options.max_iterations == 0
        || !options.grid_step.is_finite()
        || options.grid_step <= 0.0
        || options.restarts == 0
        || options.beam_width == Some(0)
        || options.max_candidates_per_state == Some(0)
        || options.max_search_states == Some(0)
        || options
            .candidate_generation_density
            .is_some_and(|density| !density.is_finite() || density <= 0.0)
    {
        return Err(PackingError::config(
            "solve options require positive iteration, grid, restart, beam, state, candidate, and density values",
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

fn learned_lattice_layouts(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    fixed: &[CandidatePlacement],
    counters: &mut Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) -> Vec<(String, Vec<CandidatePlacement>)> {
    let mut layouts = Vec::new();
    let subdivision_started = clock_start();
    let decomposed_cells = decomposed_regions(prepared);
    counters.subdivision_ms += elapsed_ms(subdivision_started);
    for variant in &prepared.variants {
        let horizontal_pitch = variant.bounds.width() + prepared.problem.clearance.item_to_item;
        for shift_fraction in [0.0, 0.5] {
            if stop_requested(options, started, counters, observer) {
                return layouts;
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
                }
            }
        }
    }
    layouts
}

fn decomposed_regions(prepared: &PreparedProblem) -> Vec<Bounds> {
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
    for exclusion in &prepared.exclusions {
        let exclusion_bounds = bounds(exclusion);
        xs.extend([exclusion_bounds.min_x, exclusion_bounds.max_x]);
        ys.extend([exclusion_bounds.min_y, exclusion_bounds.max_y]);
    }
    normalize_axis(&mut xs, 12);
    normalize_axis(&mut ys, 12);
    if prepared.exclusions.is_empty() && rectangle_region_clear(prepared, prepared.container_bounds)
    {
        return vec![prepared.container_bounds];
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
    candidates.dedup_by(|a, b| {
        (a.min_x - b.min_x).abs() <= EPSILON
            && (a.min_y - b.min_y).abs() <= EPSILON
            && (a.max_x - b.max_x).abs() <= EPSILON
            && (a.max_y - b.max_y).abs() <= EPSILON
    });
    let mut regions = Vec::new();
    for candidate in candidates {
        if regions
            .iter()
            .all(|region| !bounds_interiors_overlap(*region, candidate))
        {
            regions.push(candidate);
            if regions.len() == 12 {
                break;
            }
        }
    }
    if regions.is_empty() {
        vec![prepared.container_bounds]
    } else {
        regions
    }
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
    let rectangle = PolygonSet {
        polygons: vec![vec![
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
        ]],
    };
    set_inside(&rectangle, &prepared.container, 0.0)
        && prepared
            .exclusions
            .iter()
            .all(|exclusion| !sets_overlap(&rectangle, exclusion))
}

fn bounds_interiors_overlap(first: Bounds, second: Bounds) -> bool {
    first.min_x < second.max_x - EPSILON
        && first.max_x > second.min_x + EPSILON
        && first.min_y < second.max_y - EPSILON
        && first.max_y > second.min_y + EPSILON
}

fn learned_motif_layouts(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    fixed: &[CandidatePlacement],
    counters: &mut Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) -> Vec<(String, Vec<CandidatePlacement>)> {
    let mut layouts = Vec::new();
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
        for (_, first_position, second_position) in pairs.into_iter().take(8) {
            let first = &prepared.variants[variant_indexes[first_position]];
            let second = &prepared.variants[variant_indexes[second_position]];
            for (offset, motif_bounds) in
                best_motif_offsets(first, second, prepared.problem.clearance.item_to_item)
                    .into_iter()
                    .take(2)
            {
                for (vertical_high, horizontal_high) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    let mut placed = fixed.to_vec();
                    motif_fill(
                        prepared,
                        options,
                        first,
                        second,
                        offset,
                        motif_bounds,
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
                        placed,
                    ));
                }
            }
        }
    }
    layouts
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
        .flat_map(|polygon| contact_points(polygon))
        .take(16)
        .collect::<Vec<_>>();
    let second_contacts = second
        .geometry
        .polygons
        .iter()
        .flat_map(|polygon| contact_points(polygon))
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
            let motif_bounds = bounds(&PolygonSet { polygons });
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
        !sets_overlap(first, &moved) && set_distance(first, &moved) + EPSILON >= clearance
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

#[allow(clippy::too_many_arguments)]
fn motif_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    first: &crate::prepare::PreparedVariant,
    second: &crate::prepare::PreparedVariant,
    offset: crate::Point,
    motif_bounds: Bounds,
    vertical_high: bool,
    horizontal_high: bool,
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
    observer: &mut dyn SolveObserver,
) {
    let boundary_clearance = prepared.problem.clearance.item_to_boundary;
    let moved_second = transform(&second.geometry, 0.0, offset.x, offset.y);
    let mut motif_polygons = first.geometry.polygons.clone();
    motif_polygons.extend(moved_second.polygons);
    let motif = PolygonSet {
        polygons: motif_polygons,
    };
    let clearance = prepared.problem.clearance.item_to_item;
    let pitch_x =
        learned_geometry_separation(&motif, motif_bounds, 0.0, false, clearance, counters);
    let pitch_y = learned_geometry_separation(&motif, motif_bounds, 0.0, true, clearance, counters);
    if pitch_x <= EPSILON || pitch_y <= EPSILON {
        return;
    }
    let mut y = if vertical_high {
        prepared.container_bounds.max_y - motif_bounds.max_y - boundary_clearance
    } else {
        prepared.container_bounds.min_y - motif_bounds.min_y + boundary_clearance
    };
    loop {
        let y_beyond = if vertical_high {
            y + motif_bounds.min_y < prepared.container_bounds.min_y - EPSILON
        } else {
            y + motif_bounds.max_y > prepared.container_bounds.max_y + EPSILON
        };
        if y_beyond {
            break;
        }
        let mut x = if horizontal_high {
            prepared.container_bounds.max_x - motif_bounds.max_x - boundary_clearance
        } else {
            prepared.container_bounds.min_x - motif_bounds.min_x + boundary_clearance
        };
        loop {
            if stop_requested(options, started, counters, observer) {
                return;
            }
            let x_beyond = if horizontal_high {
                x + motif_bounds.min_x < prepared.container_bounds.min_x - EPSILON
            } else {
                x + motif_bounds.max_x > prepared.container_bounds.max_x + EPSILON
            };
            if x_beyond {
                break;
            }
            try_place_pair(prepared, first, second, x, y, offset, placed, counters);
            x += if horizontal_high { -pitch_x } else { pitch_x };
        }
        // A repeated pair can leave room for one final member of the alternating chain even
        // though the complete two-item motif no longer fits. Trying both members at that next
        // origin closes odd-length rows directly and avoids spending thousands of generic
        // contact probes to recover the elementary ninth triangle in a row.
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

#[allow(clippy::too_many_arguments)]
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
    started: SolveInstant,
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
    !sets_overlap(geometry, &moved) && set_distance(geometry, &moved) + EPSILON >= clearance
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
    cross_high: bool,
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
                let mut x = if cross_high {
                    prepared.container_bounds.max_x
                        - variant.bounds.max_x
                        - prepared.problem.clearance.item_to_boundary
                } else {
                    prepared.container_bounds.min_x - variant.bounds.min_x
                        + prepared.problem.clearance.item_to_boundary
                };
                loop {
                    let cross_beyond = if cross_high {
                        x + variant.bounds.min_x < prepared.container_bounds.min_x - EPSILON
                    } else {
                        x + variant.bounds.max_x > prepared.container_bounds.max_x + EPSILON
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
                    x += if cross_high { -pitch_x } else { pitch_x };
                }
                continue;
            }
            let mut row = 0usize;
            let mut y = if cross_high {
                prepared.container_bounds.max_y
                    - variant.bounds.max_y
                    - prepared.problem.clearance.item_to_boundary
            } else {
                prepared.container_bounds.min_y - variant.bounds.min_y
                    + prepared.problem.clearance.item_to_boundary
            };
            loop {
                let cross_beyond = if cross_high {
                    y + variant.bounds.min_y < prepared.container_bounds.min_y - EPSILON
                } else {
                    y + variant.bounds.max_y > prepared.container_bounds.max_y + EPSILON
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
                y += if cross_high { -pitch_y } else { pitch_y };
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

/// Completes a locally improved incumbent using only contact-derived positions. This deliberately
/// omits the full structured grid already scanned by `greedy_fill`, making it cheap enough to run
/// after compaction and rotation in every portfolio attempt.
fn contact_fill(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
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

fn completion_variant_order(
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
        .flat_map(|polygon| contact_points(polygon))
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

fn contact_points(polygon: &[crate::Point]) -> impl Iterator<Item = crate::Point> + '_ {
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

fn feasible<'a>(
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
    let containment_started = clock_start();
    counters.exact_geometry_checks += 1;
    let inside = set_inside(
        &next.geometry,
        &prepared.container,
        prepared.problem.clearance.item_to_boundary,
    );
    counters.containment_check_ms += elapsed_ms(containment_started);
    if !inside {
        return false;
    }
    let collision_started = clock_start();
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
        if sets_overlap(&next.geometry, exclusion)
            || set_distance(&next.geometry, exclusion) + EPSILON < required
        {
            counters.collision_check_ms += elapsed_ms(collision_started);
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
        if sets_overlap(&next.geometry, &existing.geometry)
            || set_distance(&next.geometry, &existing.geometry) + EPSILON < required
        {
            counters.collision_check_ms += elapsed_ms(collision_started);
            return false;
        }
    }
    counters.collision_check_ms += elapsed_ms(collision_started);
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

fn rotate_and_compact(
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
fn remove_reinsert(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    order: &[usize],
    placed: &mut Vec<CandidatePlacement>,
    counters: &mut Counters,
    started: SolveInstant,
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
    let mut selected_shared_angles = BTreeMap::new();
    for placement in &placements {
        *counts.entry(placement.item_id.clone()).or_default() += 1;
        let item = prepared
            .problem
            .items
            .iter()
            .find(|item| item.id == placement.item_id)
            .unwrap();
        if matches!(
            item.rotation_policy,
            crate::RotationPolicy::Discrete {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            } | crate::RotationPolicy::Continuous {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            }
        ) {
            selected_shared_angles
                .entry(placement.item_id.clone())
                .or_insert(placement.rotation_deg);
        }
    }
    let bound_gap = prepared
        .simple_upper_bound
        .map(|upper| upper.saturating_sub(placements.len()));
    let accepted_placements = placements.len() as u64;
    let mut strategies_used = vec!["greedy_baseline".to_string()];
    for used in strategy.split('+') {
        if !strategies_used.iter().any(|existing| existing == used) {
            strategies_used.push(used.to_string());
        }
    }
    if counters.local_improvement_attempts > 0 {
        strategies_used.push("remove_repack".to_string());
    }
    if counters.overlap_repair_attempts > 0 {
        strategies_used.push("overlap_minimization".to_string());
    }
    if options.quality != crate::SolveQuality::Fast {
        strategies_used.push("bounded_beam".to_string());
    }
    if counters.search.conflict_graph_status != crate::ConflictGraphStatus::NotRun {
        strategies_used.push("conflict_graph".to_string());
    }
    let mut warnings = Vec::new();
    if let Some(upper) = prepared
        .simple_upper_bound
        .filter(|upper| *upper > placements.len())
    {
        warnings.push(format!(
            "the {}-item layout is independently valid, but optimality is not proven; the safe upper bound is {upper}",
            placements.len()
        ));
    }
    if counters.search.conflict_graph_status == crate::ConflictGraphStatus::CandidateSetOptimal {
        warnings.push(
            "conflict-graph optimality applies only to the finite generated candidate set"
                .to_string(),
        );
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
        selected_shared_angles,
        statistics: SolveStatistics {
            candidates_evaluated: counters.evaluated + counters.search.evaluated_candidates,
            valid_candidates: counters.valid + counters.search.valid_candidates,
            iterations: counters.iterations,
            elapsed_ms: elapsed_ms(started),
            preparation_ms: prepared.preparation_ms,
            candidate_generation_ms: counters.search.candidate_generation_ms,
            containment_check_ms: counters.containment_check_ms
                + counters.search.containment_check_ms,
            collision_check_ms: counters.collision_check_ms + counters.search.collision_check_ms,
            candidate_scoring_ms: counters.search.candidate_scoring_ms,
            subdivision_ms: counters.subdivision_ms,
            generated_candidates: counters.evaluated + counters.search.generated_candidates,
            broad_phase_rejections: counters.broad_phase_rejections
                + counters.search.broad_phase_rejections,
            exact_geometry_checks: counters.exact_geometry_checks
                + counters.search.exact_geometry_checks,
            accepted_placements,
            explored_search_states: counters.search.explored_states,
            deduplicated_search_states: counters.search.deduplicated_states,
            pruned_search_states: counters.search.pruned_states,
            area_bound_prunes: counters.search.area_bound_prunes,
            region_bound_prunes: counters.search.region_bound_prunes,
            projection_bound_prunes: counters.search.projection_bound_prunes,
            greedy_lower_bound: counters.greedy_lower_bound,
            final_upper_bound: prepared.simple_upper_bound,
            bound_gap,
            local_improvement_attempts: counters.local_improvement_attempts,
            local_improvements_accepted: counters.local_improvements_accepted,
            overlap_repair_attempts: counters.overlap_repair_attempts,
            overlap_repair_evaluated_moves: counters.overlap_repair_evaluated_moves,
            overlap_repair_accepted_moves: counters.overlap_repair_accepted_moves,
            overlap_repair_weight_updates: counters.overlap_repair_weight_updates,
            overlap_repair_successes: counters.overlap_repair_successes,
            overlap_repair_best_penalty: counters.overlap_repair_best_penalty,
            continuation_stages: counters.continuation_stages,
            continuation_repair_only_stages: counters.continuation_repair_only_stages,
            continuation_search_stages: counters.continuation_search_stages,
            continuation_full_solve_stages: counters.continuation_full_solve_stages,
            conflict_graph_candidates: counters.search.conflict_graph_candidates,
            conflict_graph_status: counters.search.conflict_graph_status,
        },
        strategies_used,
        warm_start_status: counters.warm_start_status,
        validation,
        warnings,
    }
}

pub(crate) fn validated_result_from_placements(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    placements: Vec<Placement>,
    donor: &SolveResult,
) -> Result<Option<SolveResult>, PackingError> {
    let validation = validate_placements(prepared, &placements)?;
    if !validation.valid {
        return Ok(None);
    }
    let mut counts = BTreeMap::new();
    let mut selected_shared_angles = BTreeMap::new();
    for placement in &placements {
        *counts.entry(placement.item_id.clone()).or_default() += 1;
        let item = prepared
            .problem
            .items
            .iter()
            .find(|item| item.id == placement.item_id)
            .expect("validated placement item exists");
        if matches!(
            item.rotation_policy,
            crate::RotationPolicy::Discrete {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            } | crate::RotationPolicy::Continuous {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            }
        ) {
            selected_shared_angles
                .entry(placement.item_id.clone())
                .or_insert(placement.rotation_deg);
        }
    }
    let packed_item_count = placements.len();
    let status = if Some(packed_item_count) == prepared.simple_upper_bound {
        SolveStatus::ProvenOptimal
    } else {
        SolveStatus::BestFound
    };
    let mut warnings = donor.warnings.clone();
    warnings.push(
        "layout carried from a harder sensitivity point and independently revalidated".to_string(),
    );
    Ok(Some(SolveResult {
        layout_id: layout_id(prepared, options, &placements),
        status,
        placements,
        packed_item_count,
        packed_count_by_item: counts,
        objective_score: packed_item_count as f64,
        simple_upper_bound: prepared.simple_upper_bound,
        seed: options.seed,
        solver_strategy: format!("sensitivity_carry+{}", donor.solver_strategy),
        selected_shared_angles,
        statistics: donor.statistics.clone(),
        strategies_used: {
            let mut strategies = donor.strategies_used.clone();
            strategies.insert(0, "sensitivity_warm_start".to_string());
            strategies
        },
        warm_start_status: crate::WarmStartStatus::Retained,
        validation,
        warnings,
    }))
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

fn placement_layout_key(entries: &[Placement]) -> Vec<(String, u64, u64, u64)> {
    entries
        .iter()
        .map(|entry| {
            (
                entry.item_id.clone(),
                entry.x.to_bits(),
                entry.y.to_bits(),
                entry.rotation_deg.to_bits(),
            )
        })
        .collect()
}

fn candidate_entries_from_placements(
    prepared: &PreparedProblem,
    placements: &[Placement],
) -> Result<Vec<CandidatePlacement>, PackingError> {
    placements
        .iter()
        .map(|placement| {
            let variant = prepared
                .variants
                .iter()
                .find(|variant| {
                    variant.item_id == placement.item_id
                        && same_rotation(variant.rotation_deg, placement.rotation_deg)
                })
                .ok_or_else(|| {
                    PackingError::validation(format!(
                        "search placement for '{}' uses an unprepared rotation",
                        placement.item_id
                    ))
                })?;
            Ok(candidate(
                variant,
                placement.x,
                placement.y,
                placement.fixed,
            ))
        })
        .collect()
}

fn repair_warm_start(
    prepared: &PreparedProblem,
    fixed: &[CandidatePlacement],
    placements: &[Placement],
) -> Vec<CandidatePlacement> {
    let movable = placements
        .iter()
        .filter(|placement| !placement.fixed)
        .cloned()
        .collect::<Vec<_>>();
    let mut orders = vec![movable.clone()];
    let mut reversed = movable.clone();
    reversed.reverse();
    orders.push(reversed);
    let mut by_y = movable.clone();
    by_y.sort_by(|a, b| a.y.total_cmp(&b.y).then_with(|| a.x.total_cmp(&b.x)));
    orders.push(by_y);
    let mut by_x = movable.clone();
    by_x.sort_by(|a, b| a.x.total_cmp(&b.x).then_with(|| a.y.total_cmp(&b.y)));
    orders.push(by_x);
    for restart in 0..4_u64 {
        let mut shuffled = movable.clone();
        let mut rng =
            ChaCha8Rng::seed_from_u64(0x9e3779b97f4a7c15_u64 ^ restart ^ movable.len() as u64);
        shuffled.shuffle(&mut rng);
        orders.push(shuffled);
    }
    let mut best = fixed.to_vec();
    for order in orders {
        let repaired = repair_warm_order(prepared, fixed, &order);
        if repaired.len() > best.len()
            || (repaired.len() == best.len() && layout_key(&repaired) < layout_key(&best))
        {
            best = repaired;
        }
    }
    best
}

fn repair_warm_order(
    prepared: &PreparedProblem,
    fixed: &[CandidatePlacement],
    placements: &[Placement],
) -> Vec<CandidatePlacement> {
    let mut repaired = fixed.to_vec();
    for placement in placements {
        let Some(variant) = prepared.variants.iter().find(|variant| {
            variant.item_id == placement.item_id
                && same_rotation(variant.rotation_deg, placement.rotation_deg)
        }) else {
            continue;
        };
        if item_count(&repaired, &variant.item_id)
            >= prepared.problem.items[variant.item_index].quantity as usize
        {
            continue;
        }
        let next = candidate(variant, placement.x, placement.y, false);
        let mut counters = Counters::default();
        if feasible(prepared, &next, repaired.iter(), &mut counters) {
            repaired.push(next);
        } else if let Some(adjusted) =
            locally_repair_candidate(prepared, variant, placement, &repaired)
        {
            repaired.push(adjusted);
        }
    }
    repaired
}

fn locally_repair_candidate(
    prepared: &PreparedProblem,
    variant: &crate::prepare::PreparedVariant,
    placement: &Placement,
    repaired: &[CandidatePlacement],
) -> Option<CandidatePlacement> {
    let step = variant.bounds.width().min(variant.bounds.height()) / 100.0;
    if !step.is_finite() || step <= EPSILON {
        return None;
    }
    let mut counters = Counters::default();
    for ring in 1..=24 {
        let distance = step * ring as f64;
        let offsets = [
            (-distance, 0.0),
            (distance, 0.0),
            (0.0, -distance),
            (0.0, distance),
            (-distance, -distance),
            (-distance, distance),
            (distance, -distance),
            (distance, distance),
        ];
        for (dx, dy) in offsets {
            let adjusted = candidate(variant, placement.x + dx, placement.y + dy, false);
            if feasible(prepared, &adjusted, repaired.iter(), &mut counters) {
                return Some(adjusted);
            }
        }
    }
    None
}
