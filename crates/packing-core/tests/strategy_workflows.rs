mod common;

use common::*;
use packing_core::*;

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
fn learned_clearance_motif_packs_basic_triangles_densely() {
    let mut problem = rectangle_problem(20.0, 15.0, 3.0, 3.0);
    problem.items[0].quantity = 50;
    problem.items[0].shape = Shape::Compound {
        parts: vec![ShapePart {
            shape: Box::new(Shape::Triangle {
                base: 3.0,
                height: 3.0,
            }),
            translation: Point::default(),
            rotation_deg: 0.0,
            snap: None,
        }],
    };
    problem.items[0].rotation_policy = RotationPolicy::Continuous {
        min_deg: 0.0,
        max_deg: 360.0,
        coupling: RotationCoupling::Independent,
    };
    problem.clearance = Clearance {
        item_to_item: 0.35,
        item_to_boundary: 0.3,
        item_to_exclusion: 0.25,
    };
    let mut solve_options = options();
    solve_options.seed = 7;
    solve_options.max_iterations = 10_000;
    solve_options.restarts = 3;
    solve_options.baseline_only = true;

    let result = solve(&problem, &solve_options).unwrap();

    // Four rows of nine alternating triangles are an elementary witness: adjacent sloping
    // edges are separated by 0.35 and rows are separated by the same clearance. The solver
    // should recover at least that construction without treating each triangle as its box.
    assert!(
        result.packed_item_count >= 36,
        "expected the 36-piece alternating-triangle witness, got {} via {}",
        result.packed_item_count,
        result.solver_strategy
    );
    assert!(
        result.solver_strategy.starts_with("learned_motif_"),
        "expected the clearance-aware motif baseline, got {}",
        result.solver_strategy
    );
    assert!(
        result.statistics.generated_candidates <= 15_000,
        "basic triangle packing generated {} candidates",
        result.statistics.generated_candidates
    );
    assert!(
        result.statistics.exact_geometry_checks <= 6_000,
        "basic triangle packing used {} exact checks",
        result.statistics.exact_geometry_checks
    );
    assert!(result.validation.valid);
}

#[test]
fn overlap_repair_crosses_an_infeasible_state_to_add_a_rectangle() {
    let mut problem = rectangle_problem(6.0, 2.0, 2.0, 2.0);
    problem.items[0].quantity = 3;
    problem.items[0].rotation_policy = discrete(vec![0.0]);
    let prepared = prepare_problem(&problem).unwrap();
    let warm_start = vec![
        Placement {
            item_id: "item-a".into(),
            x: -1.0,
            y: 0.0,
            rotation_deg: 0.0,
            fixed: false,
        },
        Placement {
            item_id: "item-a".into(),
            x: 1.0,
            y: 0.0,
            rotation_deg: 0.0,
            fixed: false,
        },
    ];
    assert!(validate_placements(&prepared, &warm_start).unwrap().valid);
    let mut solve_options = options();
    // The feasible-only portfolio cannot reconstruct the three-item row at this budget. The
    // overlap lane starts with a third rectangle on top of the warm layout, shifts the incumbent
    // pieces apart, and accepts the result only after exact validation.
    solve_options.max_iterations = 1;
    solve_options.restarts = 1;

    let result = solve_prepared_with_warm_start(&prepared, &solve_options, &warm_start).unwrap();

    assert_eq!(result.packed_item_count, 3);
    assert_eq!(result.status, SolveStatus::ProvenOptimal);
    assert_eq!(result.solver_strategy, "overlap_repair");
    assert!(result.statistics.overlap_repair_attempts > 0);
    assert!(result.statistics.overlap_repair_evaluated_moves > 0);
    assert!(result.statistics.overlap_repair_accepted_moves > 0);
    assert_eq!(result.statistics.overlap_repair_successes, 1);
    assert_eq!(result.statistics.overlap_repair_best_penalty, Some(0.0));
    assert!(result.validation.valid);

    let repeated = solve_prepared_with_warm_start(&prepared, &solve_options, &warm_start).unwrap();
    assert_eq!(repeated.placements, result.placements);
    assert_eq!(
        repeated.statistics.overlap_repair_evaluated_moves,
        result.statistics.overlap_repair_evaluated_moves
    );
    assert_eq!(
        repeated.statistics.overlap_repair_accepted_moves,
        result.statistics.overlap_repair_accepted_moves
    );
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
fn capsule_quality_and_studio_twenty_one_item_witness_are_validated() {
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
        direct.statistics.iterations <= 20_000,
        "direct completion regressed to {} portfolio iterations",
        direct.statistics.iterations
    );
    assert!(
        direct.statistics.generated_candidates <= 390_000,
        "direct completion regressed to {} generated candidates",
        direct.statistics.generated_candidates
    );
    assert!(
        direct.statistics.exact_geometry_checks <= 40_000,
        "direct completion regressed to {} exact checks",
        direct.statistics.exact_geometry_checks
    );
    let mut continuation_options = direct_options;
    continuation_options.max_iterations = 80_000;
    let continuation =
        solve_prepared_clearance_continuation(&prepared, &continuation_options).unwrap();
    assert_eq!(continuation.packed_item_count, 21);
    assert!(continuation.validation.valid);
    assert!(continuation.statistics.continuation_stages <= 2);
}
