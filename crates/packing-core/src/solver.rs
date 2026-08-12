use crate::geometry::{
    Bounds, EPSILON, PolygonSet, area, bounds, set_inside, sets_conflict, sets_overlap, transform,
};
use crate::numeric::same_rotation;
use crate::search::{SearchMetrics, bounded_search};
use crate::{
    PackingError, PackingErrorKind, Placement, PreparedProblem, SolveOptions, SolvePhase,
    SolveProgress, SolveResult, SolveStatistics, SolveStatus, ValidationReport, prepare_problem,
    validate_placements,
};
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;
use std::collections::BTreeMap;

const CONTINUATION_ANNEAL_SEED_SALTS: [u64; 2] = [6, 4];

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
    let started = Clock::start();
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
        ResultParts {
            entries,
            strategy: outcome.strategy,
            counters,
            started,
            validation,
            status: SolveStatus::Feasible,
        },
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
    let started = Clock::start();
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
        ResultParts {
            entries: best,
            strategy: "clearance_continuation".to_string(),
            counters,
            started,
            validation,
            status,
        },
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
    let started = Clock::start();
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
    let stop_stale_complex_portfolio = prepared.problem.items.len() == 1
        && matches!(
            prepared.problem.items[0].rotation_policy,
            crate::RotationPolicy::Continuous { .. }
        )
        && prepared.variants.iter().any(|variant| {
            variant
                .geometry
                .polygons
                .iter()
                .map(Vec::len)
                .sum::<usize>()
                > 16
        });
    let mut stale_portfolio_attempts = 0usize;
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
        let incumbent_count = best.len();
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
        if best.len() > incumbent_count {
            stale_portfolio_attempts = 0;
        } else {
            stale_portfolio_attempts += 1;
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
        // Dense learned layouts of polygonized curves make each broad continuous-angle attempt
        // expensive. If two structurally different constructive probes cannot improve the
        // contact-closed incumbent, later orders repeat the same candidate family at other
        // angles; leave the remaining budget for repair/beam stages instead of presenting a long
        // and usually fruitless angle-refinement phase.
        if stop_stale_complex_portfolio && stale_portfolio_attempts >= 2 {
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
                .is_none_or(|limit| started.elapsed_ms() < limit))
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
                .map(|limit| limit.saturating_sub(started.elapsed_ms()));
        }
        let repair = crate::overlap::repair_more(
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
    started: Clock,
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
        ResultParts {
            entries: best,
            strategy: best_strategy,
            counters,
            started,
            validation,
            status,
        },
    ))
}

mod continuation;
use continuation::clearance_continuation;

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

mod portfolio;
use portfolio::{
    alternating_fill, compact, completion_variant_order, contact_fill, feasible, greedy_fill,
    largest_container_rectangle, learned_lattice_layouts, learned_motif_layouts, portfolio_orders,
    prepare_fixed, remove_reinsert, rotate_and_compact, structured_fill,
};

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

mod annealing;

fn stop_requested(
    options: &SolveOptions,
    started: Clock,
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
            .is_some_and(|limit| started.elapsed_ms() >= limit)
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

mod result;
pub(crate) use result::validated_result_from_placements;
use result::{ResultParts, build_result};

fn item_count(placed: &[CandidatePlacement], item_id: &str) -> usize {
    placed
        .iter()
        .filter(|entry| entry.placement.item_id == item_id)
        .count()
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

mod warm_start;
use crate::clock::Clock;
use warm_start::repair_warm_start;
