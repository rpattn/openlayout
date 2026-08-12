use crate::{
    PackingError, PackingErrorKind, PackingProblem, ParameterPath, SeedPolicy, SensitivityPoint,
    SensitivityResult, SensitivityStudy, Shape, TransitionInterval, prepare_problem,
    solve_prepared, solve_prepared_with_warm_start,
};
use std::collections::BTreeMap;

pub trait SensitivityObserver {
    fn on_progress(&mut self, _progress: &crate::SensitivityProgress) {}
}

struct NoopObserver;
impl SensitivityObserver for NoopObserver {}

pub fn run_sensitivity(
    problem: &PackingProblem,
    study: &SensitivityStudy,
) -> Result<SensitivityResult, PackingError> {
    run_sensitivity_with_observer(problem, study, &mut NoopObserver)
}

pub fn run_sensitivity_with_observer(
    problem: &PackingProblem,
    study: &SensitivityStudy,
    observer: &mut impl SensitivityObserver,
) -> Result<SensitivityResult, PackingError> {
    validate_study(study)?;
    let mut evaluations = Vec::new();
    let initial_total = initial_values(study).len();
    let mut value = study.start;
    while value <= study.end + study.initial_step * 1e-9 {
        evaluate(
            problem,
            study,
            value.min(study.end),
            &mut evaluations,
            initial_total,
            crate::SensitivityPhase::Sampling,
            observer,
        )?;
        value += study.initial_step;
    }
    evaluate(
        problem,
        study,
        study.end,
        &mut evaluations,
        initial_total,
        crate::SensitivityPhase::Sampling,
        observer,
    )?;
    if study.strategy == crate::SamplingStrategy::Adaptive {
        refine(problem, study, &mut evaluations, initial_total, observer)?;
    }
    repair_monotonic_layouts(study, &mut evaluations)?;
    evaluations.sort_by(|a, b| a.value.total_cmp(&b.value));
    evaluations.dedup_by(|a, b| (a.value - b.value).abs() < study.transition_tolerance * 1e-6);
    let transitions = evaluations
        .windows(2)
        .filter(|pair| pair[0].capacity != pair[1].capacity)
        .map(|pair| TransitionInterval {
            lower_value: pair[0].value,
            upper_value: pair[1].value,
            lower_capacity: pair[0].capacity,
            upper_capacity: pair[1].capacity,
        })
        .collect();
    let mut representative_layouts = BTreeMap::new();
    for point in &evaluations {
        representative_layouts
            .entry(point.capacity)
            .or_insert_with(|| point.result.clone());
    }
    let mut warnings = Vec::new();
    if study.increasing_is_harder {
        for pair in evaluations.windows(2) {
            if pair[1].capacity > pair[0].capacity {
                warnings.push(format!("capacity increased from {} to {} as the parameter increased from {} to {}; heuristic results may be inconsistent", pair[0].capacity, pair[1].capacity, pair[0].value, pair[1].value));
            }
        }
    }
    Ok(SensitivityResult {
        evaluations,
        representative_layouts,
        transitions,
        warnings,
    })
}

fn initial_values(study: &SensitivityStudy) -> Vec<f64> {
    let mut values = Vec::new();
    let mut value = study.start;
    while value <= study.end + study.initial_step * 1e-9 {
        values.push(value.min(study.end));
        value += study.initial_step;
    }
    if values
        .last()
        .is_none_or(|last| (last - study.end).abs() >= study.transition_tolerance * 1e-6)
    {
        values.push(study.end);
    }
    values
}

fn validate_study(study: &SensitivityStudy) -> Result<(), PackingError> {
    if !study.start.is_finite()
        || !study.end.is_finite()
        || study.start > study.end
        || !study.initial_step.is_finite()
        || study.initial_step <= 0.0
        || !study.transition_tolerance.is_finite()
        || study.transition_tolerance <= 0.0
    {
        return Err(PackingError::config(
            "sensitivity range, step, and tolerance must be finite and positive",
        ));
    }
    Ok(())
}

fn evaluate(
    problem: &PackingProblem,
    study: &SensitivityStudy,
    value: f64,
    evaluations: &mut Vec<SensitivityPoint>,
    initial_total: usize,
    phase: crate::SensitivityPhase,
    observer: &mut impl SensitivityObserver,
) -> Result<(), PackingError> {
    if evaluations
        .iter()
        .any(|point| (point.value - value).abs() < study.transition_tolerance * 1e-6)
    {
        return Ok(());
    }
    let mut changed = problem.clone();
    apply_parameter(&mut changed, &study.parameter, value)?;
    let prepared = prepare_problem(&changed)?;
    let mut options = study.solve_options;
    if study.seed_policy == SeedPolicy::DeriveFromValue {
        options.seed ^= value.to_bits().rotate_left(17);
    }
    if phase == crate::SensitivityPhase::Refining {
        options.quality = crate::SolveQuality::Thorough;
    }
    let nearest = evaluations
        .iter()
        .min_by(|a, b| (a.value - value).abs().total_cmp(&(b.value - value).abs()));
    let result = if let Some(previous) = nearest {
        solve_prepared_with_warm_start(&prepared, &options, &previous.result.placements)?
    } else {
        solve_prepared(&prepared, &options)?
    };
    let capacity = result.packed_item_count;
    evaluations.push(SensitivityPoint {
        value,
        capacity,
        status: result.status,
        problem: changed,
        result,
    });
    repair_monotonic_layouts(study, evaluations)?;
    let capacity = evaluations
        .iter()
        .find(|point| (point.value - value).abs() < study.transition_tolerance * 1e-6)
        .map(|point| point.capacity)
        .unwrap_or(capacity);
    observer.on_progress(&crate::SensitivityProgress {
        completed: evaluations.len(),
        initial_total,
        value,
        capacity,
        phase,
    });
    Ok(())
}

fn repair_monotonic_layouts(
    study: &SensitivityStudy,
    evaluations: &mut [SensitivityPoint],
) -> Result<(), PackingError> {
    evaluations.sort_by(|a, b| a.value.total_cmp(&b.value));
    if evaluations.len() < 2 {
        return Ok(());
    }
    let pairs = if study.increasing_is_harder {
        (0..evaluations.len() - 1)
            .rev()
            .map(|target| (target, target + 1))
            .collect::<Vec<_>>()
    } else {
        (1..evaluations.len())
            .map(|target| (target, target - 1))
            .collect::<Vec<_>>()
    };
    for (target_index, donor_index) in pairs {
        if evaluations[donor_index].capacity <= evaluations[target_index].capacity {
            continue;
        }
        let donor = evaluations[donor_index].result.clone();
        let prepared = prepare_problem(&evaluations[target_index].problem)?;
        let mut options = study.solve_options;
        options.seed = evaluations[target_index].result.seed;
        if let Some(result) = crate::solver::validated_result_from_placements(
            &prepared,
            &options,
            donor.placements.clone(),
            &donor,
        )? {
            evaluations[target_index].capacity = result.packed_item_count;
            evaluations[target_index].status = result.status;
            evaluations[target_index].result = result;
        }
    }
    Ok(())
}

fn refine(
    problem: &PackingProblem,
    study: &SensitivityStudy,
    evaluations: &mut Vec<SensitivityPoint>,
    initial_total: usize,
    observer: &mut impl SensitivityObserver,
) -> Result<(), PackingError> {
    loop {
        evaluations.sort_by(|a, b| a.value.total_cmp(&b.value));
        let interval = evaluations
            .windows(2)
            .find(|pair| {
                pair[0].capacity != pair[1].capacity
                    && pair[1].value - pair[0].value > study.transition_tolerance
            })
            .map(|pair| (pair[0].value, pair[1].value));
        let Some((lower, upper)) = interval else {
            break;
        };
        evaluate(
            problem,
            study,
            lower + (upper - lower) / 2.0,
            evaluations,
            initial_total,
            crate::SensitivityPhase::Refining,
            observer,
        )?;
    }
    Ok(())
}

mod parameter;
use parameter::apply_parameter;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SolveOptions, SolveStatus, solve};

    #[test]
    fn validated_harder_layout_repairs_an_easier_heuristic_result() {
        let easier: PackingProblem = serde_json::from_str(r#"{
            "schema_version": 2,
            "container": {"parts": [{"id":"stock","operation":"add","shape":{"kind":"rectangle","width":10,"height":10},"translation":{"x":0,"y":0},"rotation_deg":0}]},
            "items": [{"id":"item-a","shape":{"kind":"rectangle","width":1,"height":1},"quantity":1,"rotation_policy":{"kind":"discrete","angles_deg":[0],"coupling":"independent"}}],
            "fixed_placements": [],
            "clearance": {"item_to_item":0,"item_to_boundary":0,"item_to_exclusion":0}
        }"#).unwrap();
        let mut harder = easier.clone();
        harder.items[0].shape = Shape::Rectangle {
            width: 2.0,
            height: 1.0,
        };
        let options = SolveOptions::default();
        let donor = solve(&harder, &options).unwrap();
        let mut weak = donor.clone();
        weak.placements.clear();
        weak.packed_item_count = 0;
        weak.packed_count_by_item.clear();
        weak.objective_score = 0.0;
        weak.status = SolveStatus::Infeasible;
        let study = SensitivityStudy {
            parameter: ParameterPath::ItemWidth {
                item_id: "item-a".into(),
            },
            start: 1.0,
            end: 2.0,
            initial_step: 1.0,
            transition_tolerance: 0.1,
            strategy: crate::SamplingStrategy::Sampled,
            solve_options: options,
            seed_policy: SeedPolicy::Fixed,
            increasing_is_harder: true,
        };
        let mut evaluations = vec![
            SensitivityPoint {
                value: 1.0,
                capacity: 0,
                status: weak.status,
                problem: easier,
                result: weak,
            },
            SensitivityPoint {
                value: 2.0,
                capacity: donor.packed_item_count,
                status: donor.status,
                problem: harder,
                result: donor,
            },
        ];

        repair_monotonic_layouts(&study, &mut evaluations).unwrap();

        assert_eq!(evaluations[0].capacity, 1);
        assert!(evaluations[0].result.validation.valid);
        assert!(
            evaluations[0]
                .result
                .solver_strategy
                .starts_with("sensitivity_carry+")
        );
    }
}
