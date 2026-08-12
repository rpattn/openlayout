mod common;

use common::*;
use packing_core::*;

#[test]
fn converted_gardeyn0_retains_the_high_vertex_baseline() {
    let problem: PackingProblem =
        serde_json::from_str(include_str!("../../../benchmarks/gardeyn0-90.json")).unwrap();
    let mut solve_options = options();
    solve_options.quality = SolveQuality::Fast;
    solve_options.baseline_only = true;
    solve_options.max_iterations = 5_000;
    solve_options.grid_step = 250.0;
    solve_options.restarts = 1;

    let result = solve(&problem, &solve_options).unwrap();
    assert_eq!(result.packed_item_count, 10);
    assert_eq!(result.statistics.generated_candidates, 1_250);
    assert_eq!(result.statistics.exact_geometry_checks, 228);
    assert!(result.validation.valid);
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
    assert_eq!(result.statistics.overlap_repair_successes, 1);
    assert!(result.statistics.overlap_repair_evaluated_moves <= 600);
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
        (12..=16).contains(&result.packed_item_count),
        "expected at least 12 Dighe1 pieces at the retained budget, got {}",
        result.packed_item_count
    );
    assert_eq!(result.statistics.overlap_repair_successes, 1);
    assert!(result.statistics.overlap_repair_evaluated_moves <= 1_500);
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
