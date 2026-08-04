use crate::{PackingError, Point, RegionOperation, RegionPart, Shape, ShapeAnchor, ShapePart};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

pub(crate) const EPSILON: f64 = 1e-7;

#[derive(Debug, Clone)]
pub(crate) struct PolygonSet {
    // Normalized contours. Outer contours are counter-clockwise and holes clockwise.
    pub polygons: Vec<Vec<Point>>,
}

pub(crate) fn container_region(parts: &[RegionPart]) -> Result<PolygonSet, PackingError> {
    let mut additions = PolygonSet {
        polygons: Vec::new(),
    };
    let mut subtractions = PolygonSet {
        polygons: Vec::new(),
    };
    for part in parts {
        let geometry = transform(
            &shape_to_polygons(&part.shape)?,
            part.rotation_deg,
            part.translation.x,
            part.translation.y,
        );
        match part.operation {
            RegionOperation::Add => additions = overlay(&additions, &geometry, OverlayRule::Union),
            RegionOperation::Subtract => {
                subtractions = overlay(&subtractions, &geometry, OverlayRule::Union)
            }
        }
    }
    if additions.polygons.is_empty() {
        return Err(PackingError::geometry(
            "container requires at least one additive region",
        ));
    }
    let result = if subtractions.polygons.is_empty() {
        additions
    } else {
        overlay(&additions, &subtractions, OverlayRule::Difference)
    };
    if result.polygons.is_empty() || area(&result) <= EPSILON {
        return Err(PackingError::geometry("container Boolean result is empty"));
    }
    Ok(result)
}

pub(crate) fn union_set(set: &PolygonSet) -> PolygonSet {
    set.polygons.iter().fold(
        PolygonSet {
            polygons: Vec::new(),
        },
        |result, contour| {
            overlay(
                &result,
                &PolygonSet {
                    polygons: vec![contour.clone()],
                },
                OverlayRule::Union,
            )
        },
    )
}

fn overlay(subject: &PolygonSet, clip: &PolygonSet, rule: OverlayRule) -> PolygonSet {
    if subject.polygons.is_empty() {
        return if rule == OverlayRule::Difference {
            subject.clone()
        } else {
            clip.clone()
        };
    }
    if clip.polygons.is_empty() {
        return subject.clone();
    }
    let subject_paths = to_overlay_paths(subject);
    let clip_paths = to_overlay_paths(clip);
    let shapes = subject_paths.overlay(&clip_paths, rule, FillRule::NonZero);
    PolygonSet {
        polygons: shapes
            .into_iter()
            .flat_map(|shape| shape.into_iter())
            .map(|path| {
                path.into_iter()
                    .map(|point| Point {
                        x: point[0],
                        y: point[1],
                    })
                    .collect()
            })
            .collect(),
    }
}

fn to_overlay_paths(set: &PolygonSet) -> Vec<Vec<[f64; 2]>> {
    set.polygons
        .iter()
        .map(|path| path.iter().map(|point| [point.x, point.y]).collect())
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    pub fn width(self) -> f64 {
        self.max_x - self.min_x
    }
    pub fn height(self) -> f64 {
        self.max_y - self.min_y
    }
    pub fn translated(self, x: f64, y: f64) -> Self {
        Self {
            min_x: self.min_x + x,
            min_y: self.min_y + y,
            max_x: self.max_x + x,
            max_y: self.max_y + y,
        }
    }
    pub fn overlaps(self, other: Self, gap: f64) -> bool {
        self.min_x <= other.max_x + gap
            && self.max_x + gap >= other.min_x
            && self.min_y <= other.max_y + gap
            && self.max_y + gap >= other.min_y
    }
}

pub(crate) fn shape_to_polygons(shape: &Shape) -> Result<PolygonSet, PackingError> {
    let polygons = match shape {
        Shape::Polygon { vertices } => vec![normalise_polygon(vertices)?],
        Shape::Rectangle { width, height } => {
            if !width.is_finite() || !height.is_finite() || *width <= 0.0 || *height <= 0.0 {
                return Err(PackingError::geometry(
                    "rectangle dimensions must be finite and positive",
                ));
            }
            let (x, y) = (width / 2.0, height / 2.0);
            vec![vec![
                Point { x: -x, y: -y },
                Point { x, y: -y },
                Point { x, y },
                Point { x: -x, y },
            ]]
        }
        Shape::Triangle { base, height } => {
            if !base.is_finite() || !height.is_finite() || *base <= 0.0 || *height <= 0.0 {
                return Err(PackingError::geometry(
                    "triangle dimensions must be finite and positive",
                ));
            }
            vec![vec![
                Point {
                    x: -base / 2.0,
                    y: -height / 2.0,
                },
                Point {
                    x: base / 2.0,
                    y: -height / 2.0,
                },
                Point {
                    x: 0.0,
                    y: height / 2.0,
                },
            ]]
        }
        Shape::Circle { radius, segments } => {
            if !radius.is_finite() || *radius <= 0.0 || *segments < 12 || *segments > 4096 {
                return Err(PackingError::geometry(
                    "circle radius must be positive and segment count must be in 12..=4096",
                ));
            }
            let mut polygon = Vec::with_capacity(*segments as usize);
            for index in 0..*segments {
                let angle = std::f64::consts::TAU * index as f64 / *segments as f64;
                polygon.push(Point {
                    x: radius * angle.cos(),
                    y: radius * angle.sin(),
                });
            }
            vec![polygon]
        }
        Shape::Bezier {
            knots,
            segments_per_curve,
        } => {
            if knots.len() < 3
                || *segments_per_curve < 3
                || *segments_per_curve > 256
                || knots.iter().any(|knot| {
                    !finite_point(knot.point)
                        || !finite_point(knot.control_in)
                        || !finite_point(knot.control_out)
                })
            {
                return Err(PackingError::geometry(
                    "bezier paths require at least three finite knots and 3..=256 segments per curve",
                ));
            }
            let mut polygon = Vec::with_capacity(knots.len() * *segments_per_curve as usize);
            for index in 0..knots.len() {
                let current = knots[index];
                let next = knots[(index + 1) % knots.len()];
                for step in 0..*segments_per_curve {
                    let t = step as f64 / *segments_per_curve as f64;
                    polygon.push(cubic_bezier(
                        current.point,
                        current.control_out,
                        next.control_in,
                        next.point,
                        t,
                    ));
                }
            }
            vec![normalise_polygon(&polygon)?]
        }
        Shape::Compound { parts } => {
            if parts.is_empty() {
                return Err(PackingError::geometry(
                    "compound shape must contain at least one part",
                ));
            }
            compound_polygons(parts)?
        }
    };
    Ok(PolygonSet { polygons })
}

fn cubic_bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: f64) -> Point {
    let inverse = 1.0 - t;
    let a = inverse * inverse * inverse;
    let b = 3.0 * inverse * inverse * t;
    let c = 3.0 * inverse * t * t;
    let d = t * t * t;
    Point {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    }
}

fn compound_polygons(parts: &[ShapePart]) -> Result<Vec<Vec<Point>>, PackingError> {
    let mut local = Vec::with_capacity(parts.len());
    let mut rotated = Vec::with_capacity(parts.len());
    for part in parts {
        if !part.rotation_deg.is_finite() || !finite_point(part.translation) {
            return Err(PackingError::geometry(
                "compound part transform must be finite",
            ));
        }
        if part
            .snap
            .as_ref()
            .is_some_and(|snap| !finite_point(snap.offset))
        {
            return Err(PackingError::geometry(
                "compound snap offset must be finite",
            ));
        }
        let geometry = shape_to_polygons(&part.shape)?;
        rotated.push(transform(&geometry, part.rotation_deg, 0.0, 0.0));
        local.push(geometry);
    }

    let mut translations = vec![None; parts.len()];
    let mut active = vec![false; parts.len()];
    for index in 0..parts.len() {
        resolve_part_translation(index, parts, &local, &mut translations, &mut active)?;
    }

    let mut output = Vec::new();
    for (geometry, translation) in rotated.iter().zip(translations) {
        let translation = translation.expect("every compound part translation was resolved");
        output.extend(transform(geometry, 0.0, translation.x, translation.y).polygons);
    }
    Ok(output)
}

fn resolve_part_translation(
    index: usize,
    parts: &[ShapePart],
    local: &[PolygonSet],
    translations: &mut [Option<Point>],
    active: &mut [bool],
) -> Result<Point, PackingError> {
    if let Some(translation) = translations[index] {
        return Ok(translation);
    }
    if active[index] {
        return Err(PackingError::config(
            "compound snap relationships must not contain a cycle",
        ));
    }
    active[index] = true;
    let translation = if let Some(snap) = &parts[index].snap {
        if snap.target_part >= parts.len() {
            return Err(PackingError::config(format!(
                "compound part {index} snaps to missing part {}",
                snap.target_part
            )));
        }
        if snap.target_part == index {
            return Err(PackingError::config(format!(
                "compound part {index} cannot snap to itself"
            )));
        }
        let target_translation =
            resolve_part_translation(snap.target_part, parts, local, translations, active)?;
        let own_anchor = rotated_anchor(&local[index], parts[index].rotation_deg, snap.own_anchor);
        let mut target_anchor = rotated_anchor(
            &local[snap.target_part],
            parts[snap.target_part].rotation_deg,
            snap.target_anchor,
        );
        target_anchor.x += target_translation.x;
        target_anchor.y += target_translation.y;
        Point {
            x: target_anchor.x - own_anchor.x + snap.offset.x,
            y: target_anchor.y - own_anchor.y + snap.offset.y,
        }
    } else {
        parts[index].translation
    };
    active[index] = false;
    translations[index] = Some(translation);
    Ok(translation)
}

fn rotated_anchor(geometry: &PolygonSet, rotation_deg: f64, anchor: ShapeAnchor) -> Point {
    let point = anchor_point(bounds(geometry), anchor);
    let radians = rotation_deg.to_radians();
    Point {
        x: point.x * radians.cos() - point.y * radians.sin(),
        y: point.x * radians.sin() + point.y * radians.cos(),
    }
}

fn anchor_point(bounds: Bounds, anchor: ShapeAnchor) -> Point {
    let center_x = (bounds.min_x + bounds.max_x) / 2.0;
    let center_y = (bounds.min_y + bounds.max_y) / 2.0;
    match anchor {
        ShapeAnchor::Center => Point {
            x: center_x,
            y: center_y,
        },
        ShapeAnchor::Top => Point {
            x: center_x,
            y: bounds.max_y,
        },
        ShapeAnchor::Bottom => Point {
            x: center_x,
            y: bounds.min_y,
        },
        ShapeAnchor::Left => Point {
            x: bounds.min_x,
            y: center_y,
        },
        ShapeAnchor::Right => Point {
            x: bounds.max_x,
            y: center_y,
        },
        ShapeAnchor::TopLeft => Point {
            x: bounds.min_x,
            y: bounds.max_y,
        },
        ShapeAnchor::TopRight => Point {
            x: bounds.max_x,
            y: bounds.max_y,
        },
        ShapeAnchor::BottomLeft => Point {
            x: bounds.min_x,
            y: bounds.min_y,
        },
        ShapeAnchor::BottomRight => Point {
            x: bounds.max_x,
            y: bounds.min_y,
        },
    }
}

fn normalise_polygon(vertices: &[Point]) -> Result<Vec<Point>, PackingError> {
    let mut points = vertices.to_vec();
    if points.len() > 1 && distance(points[0], *points.last().unwrap()) <= EPSILON {
        points.pop();
    }
    if points.len() < 3 || points.iter().any(|point| !finite_point(*point)) {
        return Err(PackingError::geometry(
            "polygon requires at least three finite, distinct vertices",
        ));
    }
    if signed_area(&points).abs() <= EPSILON {
        return Err(PackingError::geometry("polygon area must be non-zero"));
    }
    for first in 0..points.len() {
        let a1 = points[first];
        let a2 = points[(first + 1) % points.len()];
        if distance(a1, a2) <= EPSILON {
            return Err(PackingError::geometry("polygon has a zero-length edge"));
        }
        for second in (first + 1)..points.len() {
            if second == first
                || second == (first + 1) % points.len()
                || first == (second + 1) % points.len()
            {
                continue;
            }
            let b1 = points[second];
            let b2 = points[(second + 1) % points.len()];
            if segments_intersect(a1, a2, b1, b2) {
                return Err(PackingError::geometry("polygon boundary self-intersects"));
            }
        }
    }
    if signed_area(&points) < 0.0 {
        points.reverse();
    }
    Ok(points)
}

pub(crate) fn transform(set: &PolygonSet, angle: f64, x: f64, y: f64) -> PolygonSet {
    PolygonSet {
        polygons: set
            .polygons
            .iter()
            .map(|polygon| transform_polygon(polygon, angle, x, y))
            .collect(),
    }
}

fn transform_polygon(polygon: &[Point], angle: f64, x: f64, y: f64) -> Vec<Point> {
    let radians = angle.to_radians();
    let (sin, cos) = radians.sin_cos();
    polygon
        .iter()
        .map(|point| Point {
            x: point.x * cos - point.y * sin + x,
            y: point.x * sin + point.y * cos + y,
        })
        .collect()
}

pub(crate) fn bounds(set: &PolygonSet) -> Bounds {
    let mut result = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for point in set.polygons.iter().flatten() {
        result.min_x = result.min_x.min(point.x);
        result.min_y = result.min_y.min(point.y);
        result.max_x = result.max_x.max(point.x);
        result.max_y = result.max_y.max(point.y);
    }
    result
}

pub(crate) fn area(set: &PolygonSet) -> f64 {
    set.polygons
        .iter()
        .map(|polygon| signed_area(polygon))
        .sum::<f64>()
        .abs()
}

pub(crate) fn guaranteed_occupied_area(set: &PolygonSet) -> f64 {
    area(set)
}

pub(crate) fn equivalent_geometry(a: &PolygonSet, b: &PolygonSet) -> bool {
    a.polygons.len() == b.polygons.len()
        && a.polygons
            .iter()
            .zip(&b.polygons)
            .all(|(left, right)| equivalent_polygon(left, right))
}

fn equivalent_polygon(a: &[Point], b: &[Point]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    (0..b.len()).any(|offset| {
        a.iter()
            .enumerate()
            .all(|(index, point)| distance(*point, b[(index + offset) % b.len()]) <= EPSILON)
    })
}

pub(crate) fn sets_overlap(a: &PolygonSet, b: &PolygonSet) -> bool {
    for left in &a.polygons {
        for right in &b.polygons {
            for first in 0..left.len() {
                for second in 0..right.len() {
                    if segments_cross(
                        left[first],
                        left[(first + 1) % left.len()],
                        right[second],
                        right[(second + 1) % right.len()],
                    ) || collinear_interior_overlap(
                        left[first],
                        left[(first + 1) % left.len()],
                        right[second],
                        right[(second + 1) % right.len()],
                    ) {
                        return true;
                    }
                }
            }
        }
    }
    a.polygons
        .iter()
        .flatten()
        .any(|point| point_strictly_in_set(*point, b))
        || b.polygons
            .iter()
            .flatten()
            .any(|point| point_strictly_in_set(*point, a))
}

pub(crate) fn set_distance(a: &PolygonSet, b: &PolygonSet) -> f64 {
    if sets_overlap(a, b) {
        return 0.0;
    }
    let mut minimum = f64::INFINITY;
    for left in &a.polygons {
        for right in &b.polygons {
            for index_a in 0..left.len() {
                for index_b in 0..right.len() {
                    minimum = minimum.min(segment_distance(
                        left[index_a],
                        left[(index_a + 1) % left.len()],
                        right[index_b],
                        right[(index_b + 1) % right.len()],
                    ));
                }
            }
        }
    }
    minimum
}

pub(crate) fn set_inside(inner: &PolygonSet, outer: &PolygonSet, clearance: f64) -> bool {
    for polygon in &inner.polygons {
        if polygon.iter().any(|point| !point_in_set(*point, outer)) {
            return false;
        }
        for index in 0..polygon.len() {
            let a = polygon[index];
            let b = polygon[(index + 1) % polygon.len()];
            for boundary in &outer.polygons {
                for outer_index in 0..boundary.len() {
                    if segments_cross(
                        a,
                        b,
                        boundary[outer_index],
                        boundary[(outer_index + 1) % boundary.len()],
                    ) {
                        return false;
                    }
                }
            }
            let midpoint = Point {
                x: (a.x + b.x) / 2.0,
                y: (a.y + b.y) / 2.0,
            };
            if !point_in_set(midpoint, outer) {
                return false;
            }
        }
    }
    clearance <= EPSILON
        || outer
            .polygons
            .iter()
            .all(|boundary| boundary_distance(inner, boundary) + EPSILON >= clearance)
}

fn point_in_set(point: Point, set: &PolygonSet) -> bool {
    if set.polygons.iter().any(|polygon| {
        (0..polygon.len()).any(|index| {
            point_segment_distance(point, polygon[index], polygon[(index + 1) % polygon.len()])
                <= EPSILON
        })
    }) {
        return true;
    }
    set.polygons.iter().fold(false, |inside, polygon| {
        inside ^ point_in_polygon(point, polygon)
    })
}

fn point_strictly_in_set(point: Point, set: &PolygonSet) -> bool {
    if set.polygons.iter().any(|polygon| {
        (0..polygon.len()).any(|index| {
            point_segment_distance(point, polygon[index], polygon[(index + 1) % polygon.len()])
                <= EPSILON
        })
    }) {
        return false;
    }
    point_in_set(point, set)
}

fn boundary_distance(inner: &PolygonSet, outer: &[Point]) -> f64 {
    let mut minimum = f64::INFINITY;
    for polygon in &inner.polygons {
        for first in 0..polygon.len() {
            for second in 0..outer.len() {
                minimum = minimum.min(segment_distance(
                    polygon[first],
                    polygon[(first + 1) % polygon.len()],
                    outer[second],
                    outer[(second + 1) % outer.len()],
                ));
            }
        }
    }
    minimum
}

fn segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool {
    let o1 = cross(a, b, c);
    let o2 = cross(a, b, d);
    let o3 = cross(c, d, a);
    let o4 = cross(c, d, b);
    o1 * o2 < -EPSILON && o3 * o4 < -EPSILON
}

fn collinear_interior_overlap(a: Point, b: Point, c: Point, d: Point) -> bool {
    if cross(a, b, c).abs() > EPSILON || cross(a, b, d).abs() > EPSILON {
        return false;
    }
    let direction_dot = (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y);
    if direction_dot <= 0.0 {
        return false;
    }
    let overlap = if (b.x - a.x).abs() >= (b.y - a.y).abs() {
        a.x.max(b.x).min(c.x.max(d.x)) - a.x.min(b.x).max(c.x.min(d.x))
    } else {
        a.y.max(b.y).min(c.y.max(d.y)) - a.y.min(b.y).max(c.y.min(d.y))
    };
    overlap > EPSILON
}

fn point_in_polygon(point: Point, polygon: &[Point]) -> bool {
    let mut inside = false;
    for index in 0..polygon.len() {
        let a = polygon[index];
        let b = polygon[(index + 1) % polygon.len()];
        if point_segment_distance(point, a, b) <= EPSILON {
            return true;
        }
        if (a.y > point.y) != (b.y > point.y) {
            let intersection_x = (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
            if point.x < intersection_x {
                inside = !inside;
            }
        }
    }
    inside
}

fn segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool {
    let o1 = cross(a, b, c);
    let o2 = cross(a, b, d);
    let o3 = cross(c, d, a);
    let o4 = cross(c, d, b);
    if o1.abs() <= EPSILON && point_segment_distance(c, a, b) <= EPSILON {
        return true;
    }
    if o2.abs() <= EPSILON && point_segment_distance(d, a, b) <= EPSILON {
        return true;
    }
    if o3.abs() <= EPSILON && point_segment_distance(a, c, d) <= EPSILON {
        return true;
    }
    if o4.abs() <= EPSILON && point_segment_distance(b, c, d) <= EPSILON {
        return true;
    }
    (o1 > 0.0) != (o2 > 0.0) && (o3 > 0.0) != (o4 > 0.0)
}

fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    if segments_intersect(a, b, c, d) {
        0.0
    } else {
        point_segment_distance(a, c, d)
            .min(point_segment_distance(b, c, d))
            .min(point_segment_distance(c, a, b))
            .min(point_segment_distance(d, a, b))
    }
}

fn point_segment_distance(point: Point, a: Point, b: Point) -> f64 {
    let length_squared = (b.x - a.x).powi(2) + (b.y - a.y).powi(2);
    if length_squared <= EPSILON {
        return distance(point, a);
    }
    let t = (((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length_squared)
        .clamp(0.0, 1.0);
    distance(
        point,
        Point {
            x: a.x + t * (b.x - a.x),
            y: a.y + t * (b.y - a.y),
        },
    )
}

fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}
fn distance(a: Point, b: Point) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}
fn signed_area(polygon: &[Point]) -> f64 {
    (0..polygon.len())
        .map(|index| {
            polygon[index].x * polygon[(index + 1) % polygon.len()].y
                - polygon[(index + 1) % polygon.len()].x * polygon[index].y
        })
        .sum::<f64>()
        / 2.0
}
fn finite_point(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_anchors_rotate_with_the_local_shape_frame() {
        let geometry = shape_to_polygons(&Shape::Rectangle {
            width: 4.0,
            height: 2.0,
        })
        .unwrap();
        let right = rotated_anchor(&geometry, 30.0, ShapeAnchor::Right);
        assert!((right.x - 2.0 * 30.0_f64.to_radians().cos()).abs() < EPSILON);
        assert!((right.y - 2.0 * 30.0_f64.to_radians().sin()).abs() < EPSILON);
    }
}
