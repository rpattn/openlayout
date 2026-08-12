mod common;

use common::*;
use packing_core::*;

#[test]
fn repeated_seed_reproduces_the_layout_and_search_counts() {
    let problem = rectangle_problem(10.0, 6.0, 2.0, 2.0);
    let prepared = prepare_problem(&problem).unwrap();
    let first = solve_prepared(&prepared, &options()).unwrap();
    let second = solve_prepared(&prepared, &options()).unwrap();

    assert_eq!(first.placements, second.placements);
    assert_eq!(first.layout_id, second.layout_id);
    assert_eq!(first.solver_strategy, second.solver_strategy);
    assert_eq!(
        first.statistics.candidates_evaluated,
        second.statistics.candidates_evaluated
    );
    assert_eq!(
        first.statistics.valid_candidates,
        second.statistics.valid_candidates
    );
    assert_eq!(first.seed, second.seed);
}

#[test]
fn result_strategy_provenance_is_unique() {
    let prepared = prepare_problem(&rectangle_problem(4.0, 4.0, 1.0, 1.0)).unwrap();
    let result = solve_prepared_feasibility(&prepared, &options(), 1)
        .unwrap()
        .result
        .unwrap();
    let unique = result
        .strategies_used
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), result.strategies_used.len());
}

#[test]
fn adaptive_sensitivity_finds_a_capacity_transition() {
    let mut problem = rectangle_problem(12.0, 4.0, 2.0, 4.0);
    problem.items[0].rotation_policy = discrete(vec![0.0]);
    problem.items[0].shape = Shape::Compound {
        parts: vec![ShapePart {
            shape: Box::new(Shape::Rectangle {
                width: 2.0,
                height: 4.0,
            }),
            translation: Point::default(),
            rotation_deg: 0.0,
            snap: None,
        }],
    };
    let study = SensitivityStudy {
        parameter: ParameterPath::ItemPartWidth {
            item_id: "item-a".into(),
            part_index: 0,
        },
        start: 2.0,
        end: 4.0,
        initial_step: 1.0,
        transition_tolerance: 0.05,
        strategy: SamplingStrategy::Adaptive,
        solve_options: options(),
        seed_policy: SeedPolicy::Fixed,
        increasing_is_harder: true,
    };
    let result = run_sensitivity(&problem, &study).unwrap();

    assert!(result.evaluations.len() > 3);
    assert!(!result.transitions.is_empty());
    assert!(
        result
            .transitions
            .iter()
            .all(|interval| interval.upper_value - interval.lower_value
                <= study.transition_tolerance + 1e-9)
    );
    assert!(result.representative_layouts.len() >= 2);
    assert!(
        result
            .evaluations
            .windows(2)
            .all(|pair| pair[1].capacity <= pair[0].capacity)
    );
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert!(
        result
            .evaluations
            .iter()
            .skip(1)
            .any(|point| point.result.warm_start_status != WarmStartStatus::FromEmpty)
    );
    assert!(
        result
            .evaluations
            .iter()
            .all(|point| point.result.validation.valid)
    );
}

#[test]
fn feasibility_stops_at_a_target_and_rejects_one_above_a_valid_bound() {
    let problem = rectangle_problem(4.0, 4.0, 2.0, 2.0);
    let prepared = prepare_problem(&problem).unwrap();
    let feasible = solve_prepared_feasibility(&prepared, &options(), 4).unwrap();
    assert_eq!(feasible.status, FeasibilityStatus::Feasible);
    assert_eq!(feasible.result.unwrap().packed_item_count, 4);

    let impossible = solve_prepared_feasibility(&prepared, &options(), 5).unwrap();
    assert_eq!(impossible.status, FeasibilityStatus::ImpossibleByBound);
    assert!(impossible.result.is_none());
    assert_eq!(impossible.valid_upper_bound, Some(4));

    let optimized = solve_prepared(&prepared, &options()).unwrap();
    assert_eq!(optimized.packed_item_count, 4);
    assert!(optimized.statistics.pruned_search_states > 0);
    assert!(optimized.statistics.projection_bound_prunes > 0);
}

#[test]
fn bounded_mode_never_loses_the_greedy_lower_bound() {
    let mut problem = rectangle_problem(11.0, 7.0, 3.0, 2.0);
    problem.container.parts[0].shape = Shape::Polygon {
        vertices: vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 11.0, y: 0.0 },
            Point { x: 11.0, y: 7.0 },
            Point { x: 7.0, y: 7.0 },
            Point { x: 7.0, y: 5.0 },
            Point { x: 0.0, y: 5.0 },
        ],
    };
    let prepared = prepare_problem(&problem).unwrap();
    let mut fast_options = options();
    fast_options.quality = SolveQuality::Fast;
    let fast = solve_prepared(&prepared, &fast_options).unwrap();
    let mut width_one_options = fast_options;
    width_one_options.beam_width = Some(1);
    let width_one = solve_prepared(&prepared, &width_one_options).unwrap();
    let balanced = solve_prepared(&prepared, &options()).unwrap();

    assert!(width_one.packed_item_count >= fast.packed_item_count);
    assert!(width_one.statistics.explored_search_states > 0);
    assert!(balanced.packed_item_count >= fast.packed_item_count);
    assert!(balanced.packed_item_count >= balanced.statistics.greedy_lower_bound);
    assert!(balanced.validation.valid);

    let mut tiny_fast_options = fast_options;
    tiny_fast_options.max_iterations = 50;
    tiny_fast_options.restarts = 1;
    let tiny_fast = solve_prepared(&prepared, &tiny_fast_options).unwrap();
    let mut tiny_beam_options = tiny_fast_options;
    tiny_beam_options.quality = SolveQuality::Balanced;
    let tiny_beam = solve_prepared(&prepared, &tiny_beam_options).unwrap();
    assert!(tiny_beam.packed_item_count > tiny_fast.packed_item_count);
    assert!(tiny_beam.validation.valid);
}

#[test]
fn baseline_only_stops_before_portfolio_and_bounded_refinement() {
    let problem = rectangle_problem(8.0, 4.0, 2.0, 2.0);
    let prepared = prepare_problem(&problem).unwrap();
    let mut solve_options = options();
    solve_options.baseline_only = true;
    solve_options.quality = SolveQuality::Thorough;
    let mut observer = RecordingObserver::default();
    let result = solve_with_observer(&prepared, &solve_options, &mut observer).unwrap();

    assert_eq!(result.packed_item_count, 8);
    assert!(result.validation.valid);
    assert_eq!(result.statistics.explored_search_states, 0);
    assert_eq!(result.statistics.local_improvement_attempts, 0);
    assert_eq!(result.statistics.continuation_stages, 0);
    assert!(
        observer
            .progress
            .iter()
            .any(|entry| entry.phase == SolvePhase::Baseline)
    );
    assert!(
        observer
            .progress
            .iter()
            .any(|entry| entry.phase == SolvePhase::Validating)
    );
    assert!(
        observer
            .progress
            .iter()
            .all(|entry| matches!(entry.phase, SolvePhase::Baseline | SolvePhase::Validating))
    );
}
