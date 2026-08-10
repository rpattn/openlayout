mod error;
mod geometry;
mod model;
mod overlap;
mod prepare;
mod search;
mod sensitivity;
mod solver;
mod validate;

pub use error::{PackingError, PackingErrorKind};
pub use geometry::resolve_problem_geometry;
pub use model::*;
pub use prepare::{PreparedProblem, prepare_problem};
pub use sensitivity::{SensitivityObserver, run_sensitivity, run_sensitivity_with_observer};
pub use solver::{
    SolveObserver, solve, solve_feasibility, solve_prepared, solve_prepared_clearance_continuation,
    solve_prepared_direct, solve_prepared_feasibility, solve_prepared_with_warm_start,
    solve_with_observer, solve_with_observer_clearance_continuation, solve_with_observer_direct,
};
pub use validate::{validate_placements, validate_problem};
