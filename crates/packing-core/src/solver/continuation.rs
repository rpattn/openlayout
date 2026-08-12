use super::annealing::anneal_elongated_continuation;
use super::*;

pub(super) fn clearance_continuation(
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
    let mut stages = 0;
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
        stages += 1;
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
        let target_seed = donor
            .iter()
            .cloned()
            .map(|mut placement| {
                placement.x += origin_x;
                placement.y += origin_y;
                placement
            })
            .collect::<Vec<_>>();
        let repaired_to_target = stage == 1
            && donor.len() > preview_seed.len()
            && CONTINUATION_ANNEAL_SEED_SALTS
                .into_iter()
                .find_map(|salt| {
                    anneal_elongated_continuation(
                        prepared,
                        &target_seed,
                        options.seed ^ salt,
                        options
                            .max_iterations
                            .saturating_mul(5)
                            .div_ceil(2)
                            .clamp(100_000, 250_000),
                    )
                })
                .is_some_and(|repaired| {
                    donor = repaired
                        .into_iter()
                        .map(|mut placement| {
                            placement.x -= origin_x;
                            placement.y -= origin_y;
                            placement
                        })
                        .collect();
                    true
                });
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
        if repaired_to_target || stage + 1 == fractions.len() {
            preview = translated;
        }
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::ClearanceContinuation,
            completed_fraction: if repaired_to_target {
                1.0
            } else {
                (stage + 1) as f64 / fractions.len() as f64
            },
            max_iterations: continuation_options.max_iterations,
            iterations: 0,
            packed_item_count: preview.len(),
            placements: preview.clone(),
            solver_strategy: "clearance_continuation".to_string(),
        });
        if repaired_to_target {
            repair_only_stages += 1;
            break;
        }
    }
    for placement in &mut donor {
        placement.x += origin_x;
        placement.y += origin_y;
    }
    Ok(ContinuationOutcome {
        placements: donor,
        stages,
        repair_only_stages,
        search_stages,
        full_solve_stages,
    })
}

pub(super) struct ContinuationOutcome {
    pub(super) placements: Vec<Placement>,
    pub(super) stages: u64,
    pub(super) repair_only_stages: u64,
    pub(super) search_stages: u64,
    pub(super) full_solve_stages: u64,
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
