use super::*;

pub(super) struct ResultParts {
    pub(super) entries: Vec<CandidatePlacement>,
    pub(super) strategy: String,
    pub(super) counters: Counters,
    pub(super) started: Clock,
    pub(super) validation: ValidationReport,
    pub(super) status: SolveStatus,
}

pub(super) fn build_result(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    parts: ResultParts,
) -> SolveResult {
    let ResultParts {
        entries,
        strategy,
        counters,
        started,
        validation,
        status,
    } = parts;
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
    let final_upper_bound = counters
        .certified_upper_bound
        .or(prepared.simple_upper_bound);
    let bound_gap = final_upper_bound.map(|upper| upper.saturating_sub(placements.len()));
    let accepted_placements = placements.len() as u64;
    let mut strategies_used = vec!["greedy_baseline".to_string()];
    let add_strategy = |strategies: &mut Vec<String>, value: &str| {
        if !strategies.iter().any(|existing| existing == value) {
            strategies.push(value.to_string());
        }
    };
    for used in strategy.split('+') {
        add_strategy(&mut strategies_used, used);
    }
    if counters.local_improvement_attempts > 0 {
        add_strategy(&mut strategies_used, "remove_repack");
    }
    if counters.overlap_repair_attempts > 0 {
        add_strategy(&mut strategies_used, "overlap_minimization");
    }
    if options.quality != crate::SolveQuality::Fast {
        add_strategy(&mut strategies_used, "bounded_beam");
    }
    if counters.search.conflict_graph_status != crate::ConflictGraphStatus::NotRun {
        add_strategy(&mut strategies_used, "conflict_graph");
    }
    let mut warnings = Vec::new();
    if let Some(upper) = final_upper_bound.filter(|upper| *upper > placements.len()) {
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
            elapsed_ms: started.elapsed_ms(),
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
            final_upper_bound,
            bound_gap,
            local_improvement_attempts: counters.local_improvement_attempts,
            local_improvements_accepted: counters.local_improvements_accepted,
            overlap_repair_attempts: counters.overlap_repair_attempts,
            overlap_repair_evaluated_moves: counters.overlap_repair_evaluated_moves,
            overlap_repair_accepted_moves: counters.overlap_repair_accepted_moves,
            overlap_repair_weight_updates: counters.overlap_repair_weight_updates,
            overlap_repair_successes: counters.overlap_repair_successes,
            overlap_repair_component_reinsert_attempts: counters
                .overlap_repair_component_reinsert_attempts,
            overlap_repair_component_reinsert_successes: counters
                .overlap_repair_component_reinsert_successes,
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
