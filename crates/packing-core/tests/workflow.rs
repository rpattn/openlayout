use packing_core::*;

fn container(shape: Shape) -> Container {
    Container {
        parts: vec![RegionPart {
            id: "stock".into(),
            operation: RegionOperation::Add,
            shape,
            translation: Point::default(),
            rotation_deg: 0.0,
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
    }
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
