use crate::geometry::EPSILON;

/// Returns the shortest unsigned distance between two angles in degrees.
pub(crate) fn angular_distance(first: f64, second: f64) -> f64 {
    let difference = (first - second).abs().rem_euclid(360.0);
    difference.min(360.0 - difference)
}

/// Compares rotations using the geometry kernel's global tolerance.
pub(crate) fn same_rotation(first: f64, second: f64) -> bool {
    angular_distance(first, second) < EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angular_distance_wraps_at_a_full_turn() {
        assert!((angular_distance(359.0, 1.0) - 2.0).abs() < EPSILON);
        assert!(same_rotation(0.0, 360.0));
    }
}
