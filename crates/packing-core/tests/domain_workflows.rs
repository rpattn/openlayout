mod common;

use common::*;
use packing_core::*;

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
