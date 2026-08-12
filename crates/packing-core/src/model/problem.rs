use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BezierKnot {
    pub point: Point,
    pub control_in: Point,
    pub control_out: Point,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Shape {
    Polygon {
        vertices: Vec<Point>,
    },
    Rectangle {
        width: f64,
        height: f64,
    },
    Triangle {
        base: f64,
        height: f64,
    },
    Circle {
        radius: f64,
        #[serde(default = "default_circle_segments")]
        segments: u32,
    },
    Bezier {
        knots: Vec<BezierKnot>,
        #[serde(default = "default_bezier_segments")]
        segments_per_curve: u32,
    },
    Compound {
        parts: Vec<ShapePart>,
    },
}

fn default_circle_segments() -> u32 {
    32
}

fn default_bezier_segments() -> u32 {
    12
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapePart {
    pub shape: Box<Shape>,
    #[serde(default)]
    pub translation: Point,
    #[serde(default)]
    pub rotation_deg: f64,
    #[serde(default)]
    pub snap: Option<PartSnap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapeAnchor {
    Center,
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartSnap {
    pub target_part: usize,
    pub own_anchor: ShapeAnchor,
    pub target_anchor: ShapeAnchor,
    #[serde(default)]
    pub offset: Point,
}

impl Default for Point {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Container {
    #[serde(default)]
    pub parts: Vec<RegionPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionOperation {
    Add,
    Subtract,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegionPart {
    pub id: String,
    pub operation: RegionOperation,
    pub shape: Shape,
    #[serde(default)]
    pub translation: Point,
    #[serde(default)]
    pub rotation_deg: f64,
    #[serde(default)]
    pub snap: Option<PartSnap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedResolvedGeometry {
    pub id: String,
    pub polygons: Vec<Vec<Point>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedProblemGeometry {
    pub container: Vec<Vec<Point>>,
    pub items: Vec<NamedResolvedGeometry>,
    pub exclusions: Vec<NamedResolvedGeometry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Exclusion {
    pub id: String,
    pub shape: Shape,
    #[serde(default)]
    pub clearance: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub shape: Shape,
    #[serde(default = "unlimited_quantity")]
    pub quantity: u32,
    #[serde(default)]
    pub rotation_policy: RotationPolicy,
}

fn unlimited_quantity() -> u32 {
    u32::MAX
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RotationCoupling {
    Independent,
    SharedPerItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RotationPolicy {
    Discrete {
        angles_deg: Vec<f64>,
        coupling: RotationCoupling,
    },
    Continuous {
        #[serde(default)]
        min_deg: f64,
        #[serde(default = "full_rotation")]
        max_deg: f64,
        coupling: RotationCoupling,
    },
}

impl Default for RotationPolicy {
    fn default() -> Self {
        Self::Discrete {
            angles_deg: vec![0.0],
            coupling: RotationCoupling::Independent,
        }
    }
}

fn full_rotation() -> f64 {
    360.0
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Clearance {
    #[serde(default)]
    pub item_to_item: f64,
    #[serde(default)]
    pub item_to_boundary: f64,
    #[serde(default)]
    pub item_to_exclusion: f64,
}

impl Default for Clearance {
    fn default() -> Self {
        Self {
            item_to_item: 0.0,
            item_to_boundary: 0.0,
            item_to_exclusion: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixedPlacement {
    pub item_id: String,
    pub x: f64,
    pub y: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackingProblem {
    #[serde(default)]
    pub schema_version: u32,
    pub container: Container,
    #[serde(default)]
    pub exclusions: Vec<Exclusion>,
    pub items: Vec<Item>,
    #[serde(default)]
    pub fixed_placements: Vec<FixedPlacement>,
    #[serde(default)]
    pub clearance: Clearance,
}
