use crate::{
    NamedResolvedGeometry, PackingError, PackingProblem, Point, RegionOperation, RegionPart,
    ResolvedProblemGeometry, Shape, ShapeAnchor, ShapePart,
};
use std::sync::Arc;
pub(crate) const EPSILON: f64 = 1e-7;

#[derive(Debug, Clone)]
pub(crate) struct PolygonSet {
    // Normalized contours. Outer contours are counter-clockwise and holes clockwise.
    pub polygons: Vec<Vec<Point>>,
    edge_index: Option<Arc<EdgeIndex>>,
    edge_index_offset: Point,
}

impl PolygonSet {
    pub(crate) fn new(polygons: Vec<Vec<Point>>) -> Self {
        Self {
            polygons,
            edge_index: None,
            edge_index_offset: Point { x: 0.0, y: 0.0 },
        }
    }

    pub(crate) fn enable_edge_index(&mut self) {
        self.edge_index = Some(Arc::new(EdgeIndex::new(self)));
        self.edge_index_offset = Point { x: 0.0, y: 0.0 };
    }
}

mod region;
pub use region::resolve_problem_geometry;
pub(crate) use region::{container_region, union_set};

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

#[derive(Debug, Clone, Copy)]
struct EdgeRef {
    polygon: usize,
    edge: usize,
    bounds: Bounds,
    overlap_padding: f64,
}

#[derive(Debug, Clone, Copy)]
struct EdgeNode {
    bounds: Bounds,
    children: Option<(usize, usize)>,
    start: usize,
    end: usize,
    overlap_padding: f64,
}

#[derive(Debug)]
struct EdgeIndex {
    edges: Vec<EdgeRef>,
    nodes: Vec<EdgeNode>,
    root: usize,
}

impl EdgeIndex {
    fn new(set: &PolygonSet) -> Self {
        let mut edges = set
            .polygons
            .iter()
            .enumerate()
            .flat_map(|(polygon_index, polygon)| {
                (0..polygon.len()).map(move |edge| {
                    let a = polygon[edge];
                    let b = polygon[(edge + 1) % polygon.len()];
                    EdgeRef {
                        polygon: polygon_index,
                        edge,
                        bounds: Bounds {
                            min_x: a.x.min(b.x),
                            min_y: a.y.min(b.y),
                            max_x: a.x.max(b.x),
                            max_y: a.y.max(b.y),
                        },
                        overlap_padding: EPSILON / ((b.x - a.x).hypot(b.y - a.y)).max(EPSILON),
                    }
                })
            })
            .collect::<Vec<_>>();
        debug_assert!(!edges.is_empty());
        let mut nodes = Vec::new();
        let edge_count = edges.len();
        let root = Self::build_node(&mut edges, &mut nodes, 0, edge_count);
        Self { edges, nodes, root }
    }

    fn build_node(
        edges: &mut [EdgeRef],
        nodes: &mut Vec<EdgeNode>,
        start: usize,
        end: usize,
    ) -> usize {
        let node_index = nodes.len();
        let node_bounds = edges[start..end]
            .iter()
            .map(|edge| edge.bounds)
            .reduce(merge_bounds)
            .expect("edge nodes are non-empty");
        nodes.push(EdgeNode {
            bounds: node_bounds,
            children: None,
            start,
            end,
            overlap_padding: edges[start..end]
                .iter()
                .map(|edge| edge.overlap_padding)
                .fold(0.0, f64::max),
        });
        if end - start <= 8 {
            return node_index;
        }
        let split_x = node_bounds.width() >= node_bounds.height();
        edges[start..end].sort_by(|left, right| {
            let left_center = if split_x {
                left.bounds.min_x + left.bounds.max_x
            } else {
                left.bounds.min_y + left.bounds.max_y
            };
            let right_center = if split_x {
                right.bounds.min_x + right.bounds.max_x
            } else {
                right.bounds.min_y + right.bounds.max_y
            };
            left_center.total_cmp(&right_center).then_with(|| {
                left.polygon
                    .cmp(&right.polygon)
                    .then_with(|| left.edge.cmp(&right.edge))
            })
        });
        let middle = start + (end - start) / 2;
        let left = Self::build_node(edges, nodes, start, middle);
        let right = Self::build_node(edges, nodes, middle, end);
        nodes[node_index].children = Some((left, right));
        node_index
    }
}

fn merge_bounds(left: Bounds, right: Bounds) -> Bounds {
    Bounds {
        min_x: left.min_x.min(right.min_x),
        min_y: left.min_y.min(right.min_y),
        max_x: left.max_x.max(right.max_x),
        max_y: left.max_y.max(right.max_y),
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
    Ok(PolygonSet::new(polygons))
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
    let polygons = set
        .polygons
        .iter()
        .map(|polygon| transform_polygon(polygon, angle, x, y))
        .collect();
    if angle.abs() <= EPSILON {
        PolygonSet {
            polygons,
            edge_index: set.edge_index.clone(),
            edge_index_offset: Point {
                x: set.edge_index_offset.x + x,
                y: set.edge_index_offset.y + y,
            },
        }
    } else {
        PolygonSet::new(polygons)
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
    let indexed_overlap = match (&a.edge_index, &b.edge_index) {
        (Some(left), Some(right)) if left.edges.len().saturating_mul(right.edges.len()) >= 256 => {
            indexed_nodes_overlap(a, left, left.root, b, right, right.root)
        }
        _ => {
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
            false
        }
    };
    if indexed_overlap {
        return true;
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

/// Returns whether two polygon sets overlap or violate the required clearance.
///
/// Distance is non-negative, so the clearance half of the predicate cannot be true when
/// `required <= EPSILON`. Avoiding it matters for detailed polygons because exact distance
/// compares every pair of potentially competitive edges.
pub(crate) fn sets_conflict(a: &PolygonSet, b: &PolygonSet, required: f64) -> bool {
    if sets_overlap(a, b) {
        return true;
    }
    if required <= EPSILON {
        return false;
    }
    match (&a.edge_index, &b.edge_index) {
        (Some(left), Some(right)) if left.edges.len().saturating_mul(right.edges.len()) >= 256 => {
            indexed_nodes_closer_than(a, left, left.root, b, right, right.root, required)
        }
        _ => set_distance_between_disjoint_sets(a, b) + EPSILON < required,
    }
}

fn indexed_nodes_overlap(
    left_set: &PolygonSet,
    left_index: &EdgeIndex,
    left_node_index: usize,
    right_set: &PolygonSet,
    right_index: &EdgeIndex,
    right_node_index: usize,
) -> bool {
    let left_node = left_index.nodes[left_node_index];
    let right_node = right_index.nodes[right_node_index];
    if !left_node
        .bounds
        .translated(left_set.edge_index_offset.x, left_set.edge_index_offset.y)
        .overlaps(
            right_node
                .bounds
                .translated(right_set.edge_index_offset.x, right_set.edge_index_offset.y),
            left_node.overlap_padding.max(right_node.overlap_padding),
        )
    {
        return false;
    }
    match (left_node.children, right_node.children) {
        (None, None) => {
            for left_edge in &left_index.edges[left_node.start..left_node.end] {
                let (left_a, left_b) = indexed_edge_points(left_set, *left_edge);
                let left_bounds = left_edge
                    .bounds
                    .translated(left_set.edge_index_offset.x, left_set.edge_index_offset.y);
                for right_edge in &right_index.edges[right_node.start..right_node.end] {
                    if !left_bounds.overlaps(
                        right_edge.bounds.translated(
                            right_set.edge_index_offset.x,
                            right_set.edge_index_offset.y,
                        ),
                        left_edge.overlap_padding.max(right_edge.overlap_padding),
                    ) {
                        continue;
                    }
                    let (right_a, right_b) = indexed_edge_points(right_set, *right_edge);
                    if segments_cross(left_a, left_b, right_a, right_b)
                        || collinear_interior_overlap(left_a, left_b, right_a, right_b)
                    {
                        return true;
                    }
                }
            }
            false
        }
        (Some((left, right)), None) => {
            indexed_nodes_overlap(
                left_set,
                left_index,
                left,
                right_set,
                right_index,
                right_node_index,
            ) || indexed_nodes_overlap(
                left_set,
                left_index,
                right,
                right_set,
                right_index,
                right_node_index,
            )
        }
        (None, Some((left, right))) => {
            indexed_nodes_overlap(
                left_set,
                left_index,
                left_node_index,
                right_set,
                right_index,
                left,
            ) || indexed_nodes_overlap(
                left_set,
                left_index,
                left_node_index,
                right_set,
                right_index,
                right,
            )
        }
        (Some((left_child, right_child)), Some(_)) => {
            indexed_nodes_overlap(
                left_set,
                left_index,
                left_child,
                right_set,
                right_index,
                right_node_index,
            ) || indexed_nodes_overlap(
                left_set,
                left_index,
                right_child,
                right_set,
                right_index,
                right_node_index,
            )
        }
    }
}

fn indexed_nodes_closer_than(
    left_set: &PolygonSet,
    left_index: &EdgeIndex,
    left_node_index: usize,
    right_set: &PolygonSet,
    right_index: &EdgeIndex,
    right_node_index: usize,
    required: f64,
) -> bool {
    let left_node = left_index.nodes[left_node_index];
    let right_node = right_index.nodes[right_node_index];
    let left_bounds = left_node
        .bounds
        .translated(left_set.edge_index_offset.x, left_set.edge_index_offset.y);
    let right_bounds = right_node
        .bounds
        .translated(right_set.edge_index_offset.x, right_set.edge_index_offset.y);
    let threshold = required - EPSILON;
    if bounds_distance_squared(left_bounds, right_bounds) >= threshold * threshold {
        return false;
    }
    match (left_node.children, right_node.children) {
        (None, None) => left_index.edges[left_node.start..left_node.end]
            .iter()
            .any(|left_edge| {
                let (left_a, left_b) = indexed_edge_points(left_set, *left_edge);
                right_index.edges[right_node.start..right_node.end]
                    .iter()
                    .any(|right_edge| {
                        let left_bounds = left_edge
                            .bounds
                            .translated(left_set.edge_index_offset.x, left_set.edge_index_offset.y);
                        let right_bounds = right_edge.bounds.translated(
                            right_set.edge_index_offset.x,
                            right_set.edge_index_offset.y,
                        );
                        if bounds_distance_squared(left_bounds, right_bounds)
                            >= threshold * threshold
                        {
                            return false;
                        }
                        let (right_a, right_b) = indexed_edge_points(right_set, *right_edge);
                        segment_distance(left_a, left_b, right_a, right_b) + EPSILON < required
                    })
            }),
        (Some((left, right)), None) => {
            indexed_nodes_closer_than(
                left_set,
                left_index,
                left,
                right_set,
                right_index,
                right_node_index,
                required,
            ) || indexed_nodes_closer_than(
                left_set,
                left_index,
                right,
                right_set,
                right_index,
                right_node_index,
                required,
            )
        }
        (None, Some((left, right))) => {
            indexed_nodes_closer_than(
                left_set,
                left_index,
                left_node_index,
                right_set,
                right_index,
                left,
                required,
            ) || indexed_nodes_closer_than(
                left_set,
                left_index,
                left_node_index,
                right_set,
                right_index,
                right,
                required,
            )
        }
        (Some((left_child, right_child)), Some(_)) => {
            indexed_nodes_closer_than(
                left_set,
                left_index,
                left_child,
                right_set,
                right_index,
                right_node_index,
                required,
            ) || indexed_nodes_closer_than(
                left_set,
                left_index,
                right_child,
                right_set,
                right_index,
                right_node_index,
                required,
            )
        }
    }
}

fn indexed_edge_points(set: &PolygonSet, edge: EdgeRef) -> (Point, Point) {
    let polygon = &set.polygons[edge.polygon];
    (polygon[edge.edge], polygon[(edge.edge + 1) % polygon.len()])
}

fn bounds_distance_squared(left: Bounds, right: Bounds) -> f64 {
    let gap_x = if left.max_x < right.min_x {
        right.min_x - left.max_x
    } else if right.max_x < left.min_x {
        left.min_x - right.max_x
    } else {
        0.0
    };
    let gap_y = if left.max_y < right.min_y {
        right.min_y - left.max_y
    } else if right.max_y < left.min_y {
        left.min_y - right.max_y
    } else {
        0.0
    };
    gap_x * gap_x + gap_y * gap_y
}

fn set_distance_between_disjoint_sets(a: &PolygonSet, b: &PolygonSet) -> f64 {
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

pub(crate) fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
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

    #[test]
    fn segment_intersection_distinguishes_disjoint_collinear_segments() {
        let a = Point { x: 0.0, y: 0.0 };
        let b = Point { x: 1.0, y: 0.0 };
        let c = Point { x: 2.0, y: 0.0 };
        let d = Point { x: 3.0, y: 0.0 };
        assert!(segment_distance(a, b, c, d) > EPSILON);

        let c = Point { x: 0.5, y: -1.0 };
        let d = Point { x: 0.5, y: 1.0 };
        assert!(segment_distance(a, b, c, d) <= EPSILON);
    }

    #[test]
    fn conflict_skips_irrelevant_distance_at_zero_clearance() {
        let square = shape_to_polygons(&Shape::Rectangle {
            width: 1.0,
            height: 1.0,
        })
        .unwrap();
        let separated = transform(&square, 0.0, 1.5, 0.0);
        let overlapping = transform(&square, 0.0, 0.5, 0.0);

        assert!(!sets_conflict(&square, &separated, 0.0));
        assert!(!sets_conflict(&square, &separated, 0.4));
        assert!(sets_conflict(&square, &separated, 0.6));
        assert!(sets_conflict(&square, &overlapping, 0.0));
    }

    #[test]
    fn indexed_predicates_match_fallback_across_overlap_and_clearance_cases() {
        let vertices = (0..32)
            .map(|index| {
                let angle = f64::from(index) * std::f64::consts::TAU / 32.0;
                Point {
                    x: angle.cos() * (2.0 + f64::from(index % 3) * 0.05),
                    y: angle.sin() * (2.0 + f64::from(index % 3) * 0.05),
                }
            })
            .collect::<Vec<_>>();
        let fallback = shape_to_polygons(&Shape::Polygon { vertices }).unwrap();
        let mut indexed = fallback.clone();
        indexed.enable_edge_index();

        for (x, y) in [(0.0, 0.0), (0.1, 0.2), (3.9, 0.0), (4.2, 0.3), (8.0, -2.0)] {
            let fallback_moved = transform(&fallback, 0.0, x, y);
            let indexed_moved = transform(&indexed, 0.0, x, y);
            assert_eq!(
                sets_overlap(&fallback, &fallback_moved),
                sets_overlap(&indexed, &indexed_moved),
                "overlap mismatch at ({x}, {y})"
            );
            for clearance in [0.0, 0.1, 0.5, 2.0] {
                assert_eq!(
                    sets_conflict(&fallback, &fallback_moved, clearance),
                    sets_conflict(&indexed, &indexed_moved, clearance),
                    "clearance mismatch at ({x}, {y}) with {clearance}"
                );
            }
        }
    }
}
