use packing_core::*;

pub fn container(shape: Shape) -> Container {
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

pub fn discrete(angles_deg: Vec<f64>) -> RotationPolicy {
    RotationPolicy::Discrete {
        angles_deg,
        coupling: RotationCoupling::Independent,
    }
}

pub fn rectangle_problem(
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

pub fn options() -> SolveOptions {
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
#[allow(
    dead_code,
    reason = "the observer fixture is used by solve-focused integration binaries only"
)]
pub struct RecordingObserver {
    pub progress: Vec<SolveProgress>,
}

impl SolveObserver for RecordingObserver {
    fn on_progress(&mut self, progress: &SolveProgress) {
        self.progress.push(progress.clone());
    }
}
