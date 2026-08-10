use packing_core::*;

fn container(shape: Shape) -> Container {
    Container {
        parts: vec![RegionPart {
            id: "stock".into(),
            operation: RegionOperation::Add,
            shape,
            translation: Point::default(),
            rotation_deg: 0.0,
            snap: None,
        }],
    }
}

fn discrete(angles_deg: Vec<f64>) -> RotationPolicy {
    RotationPolicy::Discrete {
        angles_deg,
        coupling: RotationCoupling::Independent,
    }
}

fn rectangle_problem(
    container_width: f64,
    container_height: f64,
    item_width: f64,
    item_height: f64,
) -> PackingProblem {
    PackingProblem {
        schema_version: 2,
        container: container(Shape::Rectangle {
            width: container_width,
            height: container_height,
        }),
        exclusions: Vec::new(),
        items: vec![Item {
            id: "item-a".into(),
            shape: Shape::Rectangle {
                width: item_width,
                height: item_height,
            },
            quantity: 100,
            rotation_policy: discrete(vec![0.0, 90.0]),
        }],
        fixed_placements: Vec::new(),
        clearance: Clearance::default(),
    }
}

fn options() -> SolveOptions {
    SolveOptions {
        seed: 42,
        deterministic: true,
        max_iterations: 30_000,
        time_limit_ms: None,
        grid_step: 0.5,
        restarts: 2,
        quality: SolveQuality::Balanced,
        baseline_only: false,
        beam_width: None,
        max_candidates_per_state: None,
        max_search_states: None,
        candidate_generation_density: None,
    }
}

#[derive(Default)]
struct RecordingObserver {
    progress: Vec<SolveProgress>,
}

impl SolveObserver for RecordingObserver {
    fn on_progress(&mut self, progress: &SolveProgress) {
        self.progress.push(progress.clone());
    }
}

#[test]
fn container_snaps_and_resolved_boolean_geometry_follow_rotation() {
    let mut problem = rectangle_problem(4.0, 2.0, 1.0, 1.0);
    problem.container.parts.push(RegionPart {
        id: "joined".into(),
        operation: RegionOperation::Add,
        shape: Shape::Rectangle {
            width: 2.0,
            height: 2.0,
        },
        translation: Point { x: 99.0, y: 99.0 },
        rotation_deg: 0.0,
        snap: Some(PartSnap {
            target_part: 0,
            own_anchor: ShapeAnchor::Left,
            target_anchor: ShapeAnchor::Right,
            offset: Point { x: -1.0, y: 0.0 },
        }),
    });

    let geometry = resolve_problem_geometry(&problem);
    assert_eq!(geometry.container.len(), 1);
    let xs: Vec<_> = geometry.container[0].iter().map(|point| point.x).collect();
    assert!((xs.iter().copied().fold(f64::INFINITY, f64::min) + 2.0).abs() < 1e-7);
    assert!((xs.iter().copied().fold(f64::NEG_INFINITY, f64::max) - 3.0).abs() < 1e-7);

    problem.container.parts[0].rotation_deg = 90.0;
    problem.container.parts[1].rotation_deg = 90.0;
    problem.container.parts[1].snap.as_mut().unwrap().offset = Point { x: 0.0, y: -1.0 };
    let rotated = resolve_problem_geometry(&problem);
    assert_eq!(rotated.container.len(), 1);
    let ys: Vec<_> = rotated.container[0].iter().map(|point| point.y).collect();
    assert!((ys.iter().copied().fold(f64::INFINITY, f64::min) + 2.0).abs() < 1e-7);
    assert!((ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) - 3.0).abs() < 1e-7);
}

#[test]
fn closed_bezier_paths_are_tessellated_and_packable() {
    let mut problem = rectangle_problem(12.0, 8.0, 2.0, 2.0);
    problem.items[0].shape = Shape::Bezier {
        knots: vec![
            BezierKnot {
                point: Point { x: -2.0, y: 0.0 },
                control_in: Point { x: -2.0, y: 1.0 },
                control_out: Point { x: -2.0, y: -1.0 },
            },
            BezierKnot {
                point: Point { x: 0.0, y: -1.5 },
                control_in: Point { x: -1.0, y: -1.5 },
                control_out: Point { x: 1.0, y: -1.5 },
            },
            BezierKnot {
                point: Point { x: 2.0, y: 0.0 },
                control_in: Point { x: 2.0, y: -1.0 },
                control_out: Point { x: 2.0, y: 1.0 },
            },
            BezierKnot {
                point: Point { x: 0.0, y: 1.5 },
                control_in: Point { x: 1.0, y: 1.5 },
                control_out: Point { x: -1.0, y: 1.5 },
            },
        ],
        segments_per_curve: 12,
    };
    validate_problem(&problem).unwrap();
    let result = solve(&problem, &options()).unwrap();
    assert!(result.packed_item_count > 0);
    assert!(result.validation.valid);
}

#[test]
fn buffered_shapes_respect_separation_and_boundary_clearance() {
    let mut problem = rectangle_problem(12.0, 7.0, 3.0, 2.0);
    problem.clearance = Clearance {
        item_to_item: 0.5,
        item_to_boundary: 0.5,
        item_to_exclusion: 0.0,
    };
    let prepared = prepare_problem(&problem).unwrap();
    let result = solve_prepared(&prepared, &options()).unwrap();

    assert!(result.packed_item_count > 1);
    assert!(result.validation.valid);
    assert!(
        validate_placements(&prepared, &result.placements)
            .unwrap()
            .valid
    );

    let mut invalid = result.placements.clone();
    invalid[1].x = invalid[0].x + 3.1;
    invalid[1].y = invalid[0].y;
    assert!(!validate_placements(&prepared, &invalid).unwrap().valid);
}

#[test]
fn irregular_container_result_is_independently_valid() {
    let mut problem = rectangle_problem(1.0, 1.0, 2.0, 1.5);
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
    let result = solve_prepared(&prepared, &options()).unwrap();

    assert!(result.packed_item_count >= 10);
    assert_eq!(result.packed_item_count, result.placements.len());
    assert!(
        validate_placements(&prepared, &result.placements)
            .unwrap()
            .valid
    );
    assert_ne!(result.status, SolveStatus::Feasible);
}

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

#[test]
fn published_dighe2_target_bounds_and_validates_the_current_result() {
    // Dighe2 from the ESICUP irregular strip-packing corpus has ten fixed-orientation polygons
    // whose total area exactly tiles a 100 by 100 field.
    let polygons: &[&[(f64, f64)]] = &[
        &[(-16.5, -9.5), (16.5, -9.5), (16.5, 9.5), (-13.5, 1.5)],
        &[(-21.0, -15.0), (21.0, -15.0), (16.0, 15.0), (-21.0, 4.0)],
        &[(-10.0, -25.5), (15.0, -25.5), (15.0, 25.5), (-15.0, 4.5)],
        &[
            (-4.0, -19.0),
            (-1.0, -8.0),
            (3.0, 14.0),
            (4.0, 19.0),
            (-4.0, 17.0),
        ],
        &[
            (-33.5, -14.5),
            (-3.5, -6.5),
            (33.5, 4.5),
            (22.5, 14.5),
            (-29.5, 7.5),
        ],
        &[
            (-3.5, -35.0),
            (26.5, -14.0),
            (26.5, 35.0),
            (-7.5, 35.0),
            (-19.5, 7.0),
            (-26.5, -12.0),
            (-14.5, -25.0),
        ],
        &[
            (-26.0, -19.5),
            (26.0, -12.5),
            (14.0, 0.5),
            (21.0, 19.5),
            (-23.0, 10.5),
            (-25.0, -14.5),
        ],
        &[
            (-6.0, -32.0),
            (2.0, -30.0),
            (4.0, -5.0),
            (6.0, 32.0),
            (-6.0, 32.0),
        ],
        &[(-22.0, -18.5), (22.0, -9.5), (-6.0, 18.5), (-20.0, 18.5)],
        &[(-20.0, 14.0), (8.0, -14.0), (20.0, 14.0)],
    ];
    let problem = PackingProblem {
        schema_version: 2,
        container: container(Shape::Rectangle {
            width: 100.0,
            height: 100.0,
        }),
        exclusions: Vec::new(),
        items: polygons
            .iter()
            .enumerate()
            .map(|(index, vertices)| Item {
                id: format!("piece-{index}"),
                shape: Shape::Polygon {
                    vertices: vertices
                        .iter()
                        .map(|(x, y)| Point { x: *x, y: *y })
                        .collect(),
                },
                quantity: 1,
                rotation_policy: discrete(vec![0.0]),
            })
            .collect(),
        fixed_placements: Vec::new(),
        clearance: Clearance::default(),
    };
    let mut solve_options = options();
    solve_options.quality = SolveQuality::Balanced;
    solve_options.max_iterations = 20_000;
    solve_options.restarts = 2;
    solve_options.beam_width = Some(8);
    solve_options.max_candidates_per_state = Some(16);
    solve_options.max_search_states = Some(20_000);
    let result = solve(&problem, &solve_options).unwrap();
    assert_eq!(result.simple_upper_bound, Some(10));
    assert!(
        (7..=10).contains(&result.packed_item_count),
        "expected the bounded exact-fit frontier to retain at least 7 Dighe2 pieces, got {}",
        result.packed_item_count
    );
    assert!(result.validation.valid);
    if result.packed_item_count == 10 {
        assert_eq!(result.status, SolveStatus::ProvenOptimal);
    }
}

#[test]
fn published_dighe1_target_bounds_and_validates_the_current_result() {
    // ESICUP Dighe1 polygons 1..16. The source XML uses an up-left origin; reflecting all
    // polygons into OpenLayout's coordinate convention preserves fixed-orientation feasibility.
    let polygons: &[&[(f64, f64)]] = &[
        &[(0.0, 0.0), (35.0, 0.0), (0.0, -34.0)],
        &[(0.0, 0.0), (33.0, 0.0), (18.0, -15.0)],
        &[(0.0, 0.0), (32.0, 0.0), (32.0, -41.0), (14.0, -33.0)],
        &[
            (35.0, 0.0),
            (53.0, -15.0),
            (51.0, -38.0),
            (48.0, -62.0),
            (39.0, -57.0),
            (0.0, -34.0),
        ],
        &[
            (2.0, -15.0),
            (17.0, 0.0),
            (31.0, -33.0),
            (25.0, -34.0),
            (0.0, -38.0),
        ],
        &[(0.0, 0.0), (39.0, -23.0), (20.0, -26.0), (0.0, -66.0)],
        &[
            (3.0, -4.0),
            (28.0, 0.0),
            (30.0, -18.0),
            (32.0, -39.0),
            (25.0, -37.0),
            (0.0, -28.0),
        ],
        &[(0.0, -1.0), (6.0, 0.0), (24.0, -8.0), (2.0, -19.0)],
        &[(0.0, -11.0), (22.0, 0.0), (2.0, -32.0)],
        &[(0.0, -32.0), (20.0, 0.0), (20.0, -37.0)],
        &[(1.0, 0.0), (26.0, -9.0), (0.0, -15.0)],
        &[
            (0.0, -3.0),
            (19.0, 0.0),
            (28.0, -5.0),
            (27.0, -20.0),
            (24.0, -43.0),
        ],
        &[(20.0, 0.0), (44.0, -40.0), (0.0, -40.0)],
        &[(3.0, -6.0), (29.0, 0.0), (36.0, -2.0), (0.0, -29.0)],
        &[(0.0, -27.0), (36.0, 0.0), (56.0, -27.0)],
        &[(0.0, 0.0), (20.0, -5.0), (20.0, -27.0)],
    ];
    let problem = PackingProblem {
        schema_version: 2,
        container: container(Shape::Rectangle {
            width: 100.0,
            height: 100.0,
        }),
        exclusions: Vec::new(),
        items: polygons
            .iter()
            .enumerate()
            .map(|(index, vertices)| Item {
                id: format!("piece-{index}"),
                shape: Shape::Polygon {
                    vertices: vertices
                        .iter()
                        .map(|(x, y)| Point { x: *x, y: *y })
                        .collect(),
                },
                quantity: 1,
                rotation_policy: discrete(vec![0.0]),
            })
            .collect(),
        fixed_placements: Vec::new(),
        clearance: Clearance::default(),
    };
    let mut solve_options = options();
    solve_options.quality = SolveQuality::Balanced;
    solve_options.max_iterations = 20_000;
    solve_options.restarts = 2;
    solve_options.beam_width = Some(8);
    solve_options.max_candidates_per_state = Some(16);
    solve_options.max_search_states = Some(20_000);
    let result = solve(&problem, &solve_options).unwrap();
    assert_eq!(result.simple_upper_bound, Some(16));
    assert!(
        (10..=16).contains(&result.packed_item_count),
        "expected at least 10 Dighe1 pieces at the retained budget, got {}",
        result.packed_item_count
    );
    assert!(result.validation.valid);
    if result.packed_item_count == 16 {
        assert_eq!(result.status, SolveStatus::ProvenOptimal);
    }
}

#[test]
fn thorough_mode_can_certify_a_finite_candidate_set() {
    let mut problem = rectangle_problem(8.0, 6.0, 2.0, 2.0);
    problem.items[0].quantity = 1;
    let prepared = prepare_problem(&problem).unwrap();
    let mut thorough = options();
    thorough.quality = SolveQuality::Thorough;
    thorough.max_iterations = 2_000;
    let result = solve_prepared(&prepared, &thorough).unwrap();

    assert_eq!(result.packed_item_count, 1);
    assert_eq!(
        result.statistics.conflict_graph_status,
        ConflictGraphStatus::CandidateSetOptimal
    );
    assert!(result.statistics.conflict_graph_candidates > 0);
    assert!(result.validation.valid);
}

#[test]
fn compound_items_avoid_exclusions_and_fixed_placements_are_preserved() {
    let compound = Shape::Compound {
        parts: vec![
            ShapePart {
                shape: Box::new(Shape::Rectangle {
                    width: 3.0,
                    height: 1.0,
                }),
                translation: Point::default(),
                rotation_deg: 0.0,
                snap: None,
            },
            ShapePart {
                shape: Box::new(Shape::Circle {
                    radius: 0.6,
                    segments: 20,
                }),
                translation: Point { x: 1.7, y: 0.0 },
                rotation_deg: 0.0,
                snap: None,
            },
            ShapePart {
                shape: Box::new(Shape::Triangle {
                    base: 1.2,
                    height: 1.8,
                }),
                translation: Point { x: -1.6, y: 0.0 },
                rotation_deg: 0.0,
                snap: None,
            },
        ],
    };
    let problem = PackingProblem {
        schema_version: 2,
        container: container(Shape::Rectangle {
            width: 16.0,
            height: 10.0,
        }),
        exclusions: vec![Exclusion {
            id: "exclusion-a".into(),
            shape: Shape::Rectangle {
                width: 3.0,
                height: 3.0,
            },
            clearance: 0.2,
        }],
        items: vec![Item {
            id: "item-a".into(),
            shape: compound,
            quantity: 20,
            rotation_policy: discrete(vec![0.0, 90.0, 180.0, 270.0]),
        }],
        fixed_placements: vec![FixedPlacement {
            item_id: "item-a".into(),
            x: -5.0,
            y: -3.5,
            rotation_deg: 0.0,
        }],
        clearance: Clearance {
            item_to_item: 0.2,
            item_to_boundary: 0.1,
            item_to_exclusion: 0.2,
        },
    };
    let prepared = prepare_problem(&problem).unwrap();
    let result = solve_prepared(&prepared, &options()).unwrap();

    assert!(result.packed_item_count > 1);
    assert!(
        result
            .placements
            .iter()
            .any(|placement| placement.fixed && placement.x == -5.0 && placement.y == -3.5)
    );
    assert!(
        validate_placements(&prepared, &result.placements)
            .unwrap()
            .valid
    );
}

#[test]
fn snapped_part_tracks_a_parameterized_target_edge() {
    let make_problem = |width| PackingProblem {
        schema_version: 2,
        container: container(Shape::Rectangle {
            width: 4.0,
            height: 3.0,
        }),
        exclusions: Vec::new(),
        items: vec![Item {
            id: "item-a".into(),
            shape: Shape::Compound {
                parts: vec![
                    ShapePart {
                        shape: Box::new(Shape::Rectangle { width, height: 1.0 }),
                        translation: Point::default(),
                        rotation_deg: 0.0,
                        snap: None,
                    },
                    ShapePart {
                        shape: Box::new(Shape::Circle {
                            radius: 0.5,
                            segments: 24,
                        }),
                        // A nonsensical fallback makes this test prove that the snap, rather than
                        // the stored translation, controls prepared geometry.
                        translation: Point { x: -100.0, y: 0.0 },
                        rotation_deg: 0.0,
                        snap: Some(PartSnap {
                            target_part: 0,
                            own_anchor: ShapeAnchor::Left,
                            target_anchor: ShapeAnchor::Right,
                            offset: Point::default(),
                        }),
                    },
                ],
            },
            quantity: 1,
            rotation_policy: discrete(vec![0.0]),
        }],
        fixed_placements: vec![FixedPlacement {
            item_id: "item-a".into(),
            x: 0.0,
            y: 0.0,
            rotation_deg: 0.0,
        }],
        clearance: Clearance::default(),
    };

    let fitting = prepare_problem(&make_problem(2.0)).unwrap();
    assert!(
        solve_prepared(&fitting, &options())
            .unwrap()
            .validation
            .valid
    );

    let too_wide = prepare_problem(&make_problem(3.0)).unwrap();
    let error = solve_prepared(&too_wide, &options()).unwrap_err();
    assert_eq!(error.kind, PackingErrorKind::ImpossibleClearance);
}

#[test]
fn boolean_container_holes_and_disconnected_islands_are_enforced() {
    let mut problem = rectangle_problem(1.0, 1.0, 2.0, 2.0);
    problem.container.parts = vec![
        RegionPart {
            id: "left".into(),
            operation: RegionOperation::Add,
            shape: Shape::Rectangle {
                width: 6.0,
                height: 6.0,
            },
            translation: Point { x: -4.0, y: 0.0 },
            rotation_deg: 0.0,
            snap: None,
        },
        RegionPart {
            id: "right".into(),
            operation: RegionOperation::Add,
            shape: Shape::Rectangle {
                width: 6.0,
                height: 6.0,
            },
            translation: Point { x: 4.0, y: 0.0 },
            rotation_deg: 0.0,
            snap: None,
        },
        RegionPart {
            id: "hole".into(),
            operation: RegionOperation::Subtract,
            shape: Shape::Circle {
                radius: 1.25,
                segments: 32,
            },
            translation: Point { x: -4.0, y: 0.0 },
            rotation_deg: 0.0,
            snap: None,
        },
    ];
    let prepared = prepare_problem(&problem).unwrap();
    let result = solve_prepared(&prepared, &options()).unwrap();
    assert!(result.packed_item_count >= 8);
    assert!(result.placements.iter().any(|placement| placement.x > 1.0));
    assert!(result.placements.iter().any(|placement| placement.x < -1.0));
    assert!(result.validation.valid);

    let invalid = vec![Placement {
        item_id: "item-a".into(),
        x: -4.0,
        y: 0.0,
        rotation_deg: 0.0,
        fixed: false,
    }];
    assert!(!validate_placements(&prepared, &invalid).unwrap().valid);
}

#[test]
fn adaptive_rotation_finds_better_orthogonal_and_edge_aligned_layouts() {
    let mut fixed = rectangle_problem(6.0, 4.0, 4.0, 3.0);
    fixed.items[0].rotation_policy = discrete(vec![0.0]);
    let fixed_count = solve(&fixed, &options()).unwrap().packed_item_count;
    fixed.items[0].rotation_policy = RotationPolicy::Continuous {
        min_deg: 0.0,
        max_deg: 360.0,
        coupling: RotationCoupling::Independent,
    };
    let adaptive = solve(&fixed, &options()).unwrap();
    assert!(adaptive.packed_item_count > fixed_count);
    assert!(
        adaptive
            .placements
            .iter()
            .any(|placement| (placement.rotation_deg - 90.0).abs() < 1e-7)
    );

    let mut sloped = rectangle_problem(1.0, 1.0, 4.0, 2.0);
    sloped.container.parts[0] = RegionPart {
        id: "stock".into(),
        operation: RegionOperation::Add,
        shape: Shape::Rectangle {
            width: 12.0,
            height: 4.0,
        },
        translation: Point::default(),
        rotation_deg: 23.0,
        snap: None,
    };
    sloped.items[0].rotation_policy = RotationPolicy::Continuous {
        min_deg: 0.0,
        max_deg: 360.0,
        coupling: RotationCoupling::Independent,
    };
    let result = solve(&sloped, &options()).unwrap();
    assert!(result.placements.iter().any(|placement| {
        let delta = (placement.rotation_deg - 23.0).rem_euclid(90.0);
        delta.min(90.0 - delta) < 1e-7
    }));
}

#[test]
fn shared_rotation_policy_rejects_mixed_copy_angles() {
    let mut problem = rectangle_problem(10.0, 10.0, 2.0, 1.0);
    problem.items[0].rotation_policy = RotationPolicy::Discrete {
        angles_deg: vec![0.0, 90.0],
        coupling: RotationCoupling::SharedPerItem,
    };
    let prepared = prepare_problem(&problem).unwrap();
    let placements = vec![
        Placement {
            item_id: "item-a".into(),
            x: -3.0,
            y: 0.0,
            rotation_deg: 0.0,
            fixed: false,
        },
        Placement {
            item_id: "item-a".into(),
            x: 3.0,
            y: 0.0,
            rotation_deg: 90.0,
            fixed: false,
        },
    ];
    assert!(!validate_placements(&prepared, &placements).unwrap().valid);
    let result = solve_prepared(&prepared, &options()).unwrap();
    let first = result.placements[0].rotation_deg;
    assert!(
        result
            .placements
            .iter()
            .all(|placement| (placement.rotation_deg - first).abs() < 1e-7)
    );
}

#[test]
fn legacy_schema_is_rejected_with_an_explicit_version_error() {
    let legacy = r#"{
        "container": { "boundary": { "kind": "rectangle", "width": 10, "height": 10 } },
        "items": [{ "id": "item-a", "shape": { "kind": "rectangle", "width": 1, "height": 1 }, "rotations": [0] }]
    }"#;
    let problem: PackingProblem = serde_json::from_str(legacy).unwrap();
    let error = validate_problem(&problem).unwrap_err();
    assert!(error.message.contains("schema_version 2"));
}

#[test]
fn thorough_mode_expands_the_base_budget_reported_in_progress() {
    #[derive(Default)]
    struct ProgressCapture(Vec<SolveProgress>);
    impl SolveObserver for ProgressCapture {
        fn on_progress(&mut self, progress: &SolveProgress) {
            self.0.push(progress.clone());
        }
    }

    let problem = rectangle_problem(10.0, 6.0, 2.0, 2.0);
    let prepared = prepare_problem(&problem).unwrap();
    let mut solve_options = options();
    solve_options.max_iterations = 1_000;
    solve_options.quality = SolveQuality::Thorough;
    let mut observer = ProgressCapture::default();
    solve_with_observer(&prepared, &solve_options, &mut observer).unwrap();

    assert!(!observer.0.is_empty());
    assert!(
        observer
            .0
            .iter()
            .all(|progress| progress.max_iterations == 4_000)
    );
}

#[test]
fn learned_lattice_reaches_square_and_hexagonal_reference_counts() {
    let rectangles = rectangle_problem(10.0, 6.0, 2.0, 2.0);
    let rectangle_result = solve(&rectangles, &options()).unwrap();
    assert_eq!(rectangle_result.packed_item_count, 15);

    let mut circles = rectangle_problem(10.0, 2.0 + 4.0 * 3.0_f64.sqrt(), 2.0, 2.0);
    circles.items[0].shape = Shape::Circle {
        radius: 1.0,
        segments: 64,
    };
    circles.items[0].rotation_policy = discrete(vec![0.0]);
    let circle_result = solve(&circles, &options()).unwrap();
    assert!(
        circle_result.packed_item_count >= 23,
        "expected five staggered rows containing 5+4+5+4+5 circles, got {} via {}",
        circle_result.packed_item_count,
        circle_result.solver_strategy
    );
    assert!(
        circle_result
            .solver_strategy
            .starts_with("learned_lattice_")
    );
}

#[test]
fn learned_complementary_motif_tiles_right_triangles_exactly() {
    let mut problem = rectangle_problem(10.0, 10.0, 2.0, 2.0);
    problem.items[0].shape = Shape::Polygon {
        vertices: vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 2.0, y: 0.0 },
            Point { x: 0.0, y: 2.0 },
        ],
    };
    problem.items[0].rotation_policy = discrete(vec![0.0, 180.0]);
    let result = solve(&problem, &options()).unwrap();

    assert_eq!(result.packed_item_count, 50);
    assert_eq!(result.status, SolveStatus::ProvenOptimal);
    assert!(result.solver_strategy.starts_with("learned_motif_"));
}

#[test]
fn learned_decomposition_fills_offset_disconnected_regions() {
    let mut problem = rectangle_problem(1.0, 1.0, 2.0, 2.0);
    problem.items[0].quantity = 4;
    problem.items[0].rotation_policy = discrete(vec![0.0]);
    problem.container.parts = vec![
        RegionPart {
            id: "left".into(),
            operation: RegionOperation::Add,
            shape: Shape::Rectangle {
                width: 4.0,
                height: 2.0,
            },
            translation: Point { x: -3.0, y: 0.0 },
            rotation_deg: 0.0,
            snap: None,
        },
        RegionPart {
            id: "right".into(),
            operation: RegionOperation::Add,
            shape: Shape::Rectangle {
                width: 4.0,
                height: 2.0,
            },
            translation: Point { x: 3.25, y: 0.0 },
            rotation_deg: 0.0,
            snap: None,
        },
    ];

    let result = solve(&problem, &options()).unwrap();
    assert_eq!(result.packed_item_count, 4);
    assert_eq!(result.status, SolveStatus::ProvenOptimal);
    assert!(
        result.solver_strategy.starts_with("learned_decomposed_"),
        "expected independently aligned region seeds, got {}",
        result.solver_strategy
    );
    assert!(result.validation.valid);
}

#[test]
fn capsule_quality_and_studio_twenty_item_witness_are_validated() {
    let exclusion_vertices = (0..32)
        .map(|index| {
            let angle = std::f64::consts::TAU * index as f64 / 32.0;
            Point {
                x: 15.0 + 2.1 * angle.cos(),
                y: 8.0 + 2.1 * angle.sin(),
            }
        })
        .collect();
    let mut problem = PackingProblem {
        schema_version: 2,
        container: Container {
            parts: vec![RegionPart {
                id: "stock".into(),
                operation: RegionOperation::Add,
                shape: Shape::Polygon {
                    vertices: vec![
                        Point { x: -15.0, y: -9.0 },
                        Point { x: 15.0, y: -9.0 },
                        Point { x: 15.0, y: 9.0 },
                        Point { x: 6.0, y: 9.0 },
                        Point { x: 6.0, y: 6.0 },
                        Point { x: -15.0, y: 6.0 },
                    ],
                },
                translation: Point { x: 15.0, y: 9.0 },
                rotation_deg: 0.0,
                snap: None,
            }],
        },
        exclusions: vec![Exclusion {
            id: "exclusion-a".into(),
            shape: Shape::Polygon {
                vertices: exclusion_vertices,
            },
            clearance: 0.25,
        }],
        items: vec![Item {
            id: "item-a".into(),
            quantity: 80,
            rotation_policy: RotationPolicy::Continuous {
                min_deg: 0.0,
                max_deg: 360.0,
                coupling: RotationCoupling::Independent,
            },
            shape: Shape::Compound {
                parts: vec![
                    ShapePart {
                        shape: Box::new(Shape::Rectangle {
                            width: 4.375,
                            height: 2.4,
                        }),
                        translation: Point::default(),
                        rotation_deg: 0.0,
                        snap: None,
                    },
                    ShapePart {
                        shape: Box::new(Shape::Circle {
                            radius: 1.1,
                            segments: 28,
                        }),
                        translation: Point::default(),
                        rotation_deg: 0.0,
                        snap: Some(PartSnap {
                            target_part: 0,
                            own_anchor: ShapeAnchor::Center,
                            target_anchor: ShapeAnchor::Left,
                            offset: Point::default(),
                        }),
                    },
                    ShapePart {
                        shape: Box::new(Shape::Circle {
                            radius: 1.1,
                            segments: 28,
                        }),
                        translation: Point::default(),
                        rotation_deg: 0.0,
                        snap: Some(PartSnap {
                            target_part: 0,
                            own_anchor: ShapeAnchor::Center,
                            target_anchor: ShapeAnchor::Right,
                            offset: Point::default(),
                        }),
                    },
                ],
            },
        }],
        fixed_placements: Vec::new(),
        clearance: Clearance {
            item_to_item: 0.35,
            item_to_boundary: 0.3,
            item_to_exclusion: 0.25,
        },
    };
    let mut solve_options = options();
    solve_options.seed = 7;
    // Thorough expands this to 40k effective iterations, half one balanced base run while
    // keeping the regression quick enough for the normal test suite.
    solve_options.max_iterations = 10_000;
    solve_options.grid_step = 0.5;
    solve_options.restarts = 3;
    solve_options.quality = SolveQuality::Thorough;

    let result = solve(&problem, &solve_options).unwrap();
    assert!(
        result.packed_item_count >= 17,
        "expected at least 17 capsules at width 4.375, got {} via {}",
        result.packed_item_count,
        result.solver_strategy
    );
    assert!(result.validation.valid);

    let Shape::Compound { parts } = &mut problem.items[0].shape else {
        unreachable!();
    };
    let Shape::Rectangle { width, .. } = parts[0].shape.as_mut() else {
        unreachable!();
    };
    *width = 4.0;
    let witness = [
        (0.0, 1.2500025078227548, -6.477806219485838),
        (0.0, -5.297998495127322, -6.3917095788562275),
        (0.0, 7.79800351077354, -6.3917095788562275),
        (2.5, -11.48011630962844, -5.136737561706125),
        (0.0, -5.249998495157124, -3.619708580391047),
        (177.5, -11.502887729328119, -2.1971122695542937),
        (0.0, 5.750003510802987, -0.8195143005609893),
        (2.5, -5.374278065339664, -0.774278067947367),
        (0.0, -11.399999998137355, 0.6999999992549419),
        (75.0, 11.676749080935835, 1.5310824296507146),
        (2.5, -5.198554629561742, 2.1041238447872477),
        (2.5, 5.250003510803342, 2.0526799791918657),
        (0.0, -11.399999998137355, 3.4860976384106857),
        (2.5, 1.2500025078231096, 4.924874258960971),
        (0.0, -5.297998495127676, 4.972874258947418),
        (0.0, 7.798003510773185, 4.92487425897722),
        (2.5, 9.600000001862645, 8.199999999254942),
        (0.0, 1.3000025078231083, -3.619708580391047),
        (0.0, 7.85000351080334, -3.619708580391047),
        (75.0, 13.023249919064165, -4.668916570349285),
    ]
    .into_iter()
    .map(|(rotation_deg, x, y)| Placement {
        item_id: "item-a".into(),
        x: x + 15.0,
        y: y + 8.0,
        rotation_deg,
        fixed: false,
    })
    .collect::<Vec<_>>();
    let prepared = prepare_problem(&problem).unwrap();
    let validation = validate_placements(&prepared, &witness).unwrap();
    assert!(validation.valid, "{}", validation.errors.join("; "));
    let mut direct_options = solve_options;
    direct_options.quality = SolveQuality::Balanced;
    direct_options.max_iterations = 40_000;
    let mut observer = RecordingObserver::default();
    let direct = solve_with_observer_direct(&prepared, &direct_options, &mut observer).unwrap();
    assert_eq!(direct.packed_item_count, 20);
    assert!(direct.validation.valid);
    assert!(direct.solver_strategy.ends_with("+contact_fill"));
    assert!(
        observer.progress.iter().any(|progress| {
            progress.phase == SolvePhase::Baseline && progress.packed_item_count == 20
        }),
        "the direct lane should complete the lattice before angle refinement"
    );
    assert!(
        direct.statistics.generated_candidates <= 450_000,
        "direct completion regressed to {} generated candidates",
        direct.statistics.generated_candidates
    );
    assert!(
        direct.statistics.exact_geometry_checks <= 80_000,
        "direct completion regressed to {} exact checks",
        direct.statistics.exact_geometry_checks
    );
}
