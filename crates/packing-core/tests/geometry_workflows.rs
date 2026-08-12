mod common;

use common::*;
use packing_core::*;

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
