import type {
  EditorState,
  PackingProblem,
  AnchorName,
  EditorItem,
  Point,
  PrimitiveEditor,
  Shape,
  ShapePart,
} from "./types";

export const defaultState = (): EditorState => ({
  containerVertices: [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 18 },
    { x: 21, y: 18 }, { x: 21, y: 15 }, { x: 0, y: 15 },
  ],
  items: [{
    id: "item-a",
    quantity: 80,
    rotations: "0, 90, 180, 270",
    parts: [
      { id: "body", kind: "rectangle", width: 4, height: 2.4, x: 0, y: 0, rotation: 0 },
      { id: "end-left", kind: "circle", radius: 1.1, segments: 28, x: -2, y: 0, rotation: 0, snap: { targetId: "body", ownAnchor: "center", targetAnchor: "left", offset: { x: 0, y: 0 } } },
      { id: "end-right", kind: "circle", radius: 1.1, segments: 28, x: 2, y: 0, rotation: 0, snap: { targetId: "body", ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } } },
    ],
  }],
  exclusions: [{
    id: "exclusion-a",
    clearance: 0.25,
    primitive: { id: "exclusion-shape-a", kind: "circle", radius: 2.1, segments: 32, x: 15, y: 8, rotation: 0 },
  }],
  fixedPlacements: [],
  clearance: { item_to_item: 0.35, item_to_boundary: 0.3, item_to_exclusion: 0.25 },
  options: {
    seed: 7,
    deterministic: true,
    max_iterations: 80_000,
    time_limit_ms: null,
    grid_step: 0.5,
    restarts: 3,
  },
  study: {
    parameterKey: "part_width:item-a:0",
    start: 3,
    end: 6,
    initial_step: 0.5,
    transition_tolerance: 0.05,
    strategy: "adaptive",
    seed_policy: "fixed",
    increasing_is_harder: true,
  },
});

export function toProblem(state: EditorState): PackingProblem {
  return {
    container: { boundary: { kind: "polygon", vertices: state.containerVertices } },
    exclusions: state.exclusions.map((entry) => ({
      id: entry.id,
      clearance: entry.clearance,
      shape: transformedPolygon(entry.primitive),
    })),
    items: state.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      rotations: parseNumbers(item.rotations),
      shape: {
        kind: "compound",
        parts: item.parts.map((part) => toShapePart(part, item.parts)),
      },
    })),
    fixed_placements: state.fixedPlacements,
    clearance: state.clearance,
  };
}

export function toShapePart(primitive: PrimitiveEditor, allParts: PrimitiveEditor[]): ShapePart {
  const resolved = resolveEditorTranslations(allParts).get(primitive.id) ?? { x: primitive.x, y: primitive.y };
  const targetPart = primitive.snap ? allParts.findIndex((part) => part.id === primitive.snap!.targetId) : -1;
  return {
    shape: primitiveShape(primitive),
    translation: resolved,
    rotation_deg: primitive.rotation,
    snap: primitive.snap && targetPart >= 0 ? {
      target_part: targetPart,
      own_anchor: primitive.snap.ownAnchor,
      target_anchor: primitive.snap.targetAnchor,
      offset: primitive.snap.offset,
    } : null,
  };
}

export function primitiveShape(primitive: PrimitiveEditor): Shape {
  switch (primitive.kind) {
    case "rectangle": return { kind: "rectangle", width: primitive.width, height: primitive.height };
    case "triangle": return { kind: "triangle", base: primitive.base, height: primitive.height };
    case "circle": return { kind: "circle", radius: primitive.radius, segments: primitive.segments };
    case "polygon": return { kind: "polygon", vertices: primitive.vertices };
  }
}

export function transformedPolygon(primitive: PrimitiveEditor): Shape {
  const points = shapePoints(primitiveShape(primitive));
  return {
    kind: "polygon",
    vertices: points.map((point) => transformPoint(point, primitive.rotation, primitive.x, primitive.y)),
  };
}

export function shapePoints(shape: Shape): Point[] {
  switch (shape.kind) {
    case "polygon": return shape.vertices;
    case "rectangle": return [
      { x: -shape.width / 2, y: -shape.height / 2 },
      { x: shape.width / 2, y: -shape.height / 2 },
      { x: shape.width / 2, y: shape.height / 2 },
      { x: -shape.width / 2, y: shape.height / 2 },
    ];
    case "triangle": return [
      { x: -shape.base / 2, y: -shape.height / 2 },
      { x: shape.base / 2, y: -shape.height / 2 },
      { x: 0, y: shape.height / 2 },
    ];
    case "circle": return Array.from({ length: shape.segments }, (_, index) => {
      const angle = Math.PI * 2 * index / shape.segments;
      return { x: shape.radius * Math.cos(angle), y: shape.radius * Math.sin(angle) };
    });
    case "compound": return [];
  }
}

export function transformPoint(point: Point, rotation: number, x: number, y: number): Point {
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: point.x * cosine - point.y * sine + x,
    y: point.x * sine + point.y * cosine + y,
  };
}

export function parsePointText(value: string): Point[] {
  return value.split(/\n|;/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [x, y] = line.split(/[ ,]+/).map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid point: ${line}`);
    return { x, y };
  });
}

export function pointText(points: Point[]): string {
  return points.map(({ x, y }) => `${x}, ${y}`).join("\n");
}

export function parseNumbers(value: string): number[] {
  return value.split(/[ ,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

export function makePrimitive(kind: PrimitiveEditor["kind"]): PrimitiveEditor {
  const id = nextPartId();
  switch (kind) {
    case "rectangle": return { id, kind, width: 4, height: 2, x: 0, y: 0, rotation: 0 };
    case "triangle": return { id, kind, base: 3, height: 3, x: 0, y: 0, rotation: 0 };
    case "circle": return { id, kind, radius: 1.5, segments: 28, x: 0, y: 0, rotation: 0 };
    case "polygon": return { id, kind, vertices: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 0, y: 2 }], x: 0, y: 0, rotation: 0 };
  }
}

export function fromProblem(problem: PackingProblem): EditorState {
  const state = defaultState();
  state.containerVertices = shapePoints(problem.container.boundary);
  state.items = problem.items.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    rotations: item.rotations.join(", "),
    parts: item.shape.kind === "compound"
      ? fromShapeParts(item.shape.parts)
      : [shapeToPrimitive(item.shape, 0, 0, 0)],
  }));
  state.exclusions = problem.exclusions.map((entry) => ({
    id: entry.id,
    clearance: entry.clearance,
    primitive: shapeToPrimitive(entry.shape, 0, 0, 0),
  }));
  state.fixedPlacements = problem.fixed_placements;
  state.clearance = problem.clearance;
  return state;
}

function shapeToPrimitive(shape: Shape, x: number, y: number, rotation: number, id = nextPartId()): PrimitiveEditor {
  switch (shape.kind) {
    case "rectangle": return { id, kind: "rectangle", width: shape.width, height: shape.height, x, y, rotation };
    case "triangle": return { id, kind: "triangle", base: shape.base, height: shape.height, x, y, rotation };
    case "circle": return { id, kind: "circle", radius: shape.radius, segments: shape.segments, x, y, rotation };
    case "polygon": return { id, kind: "polygon", vertices: shape.vertices, x, y, rotation };
    case "compound": throw new Error("Nested compound shapes cannot be edited directly");
  }
}

function fromShapeParts(parts: ShapePart[]): PrimitiveEditor[] {
  const ids = parts.map(() => nextPartId());
  return parts.map((part, index) => {
    const primitive = shapeToPrimitive(part.shape, part.translation.x, part.translation.y, part.rotation_deg, ids[index]);
    if (part.snap && ids[part.snap.target_part]) {
      primitive.snap = {
        targetId: ids[part.snap.target_part],
        ownAnchor: part.snap.own_anchor,
        targetAnchor: part.snap.target_anchor,
        offset: part.snap.offset,
      };
    }
    return primitive;
  });
}

export function resolveEditorTranslations(parts: PrimitiveEditor[]): Map<string, Point> {
  const resolved = new Map<string, Point>();
  const active = new Set<string>();
  const byId = new Map(parts.map((part) => [part.id, part]));
  const resolve = (part: PrimitiveEditor): Point => {
    const existing = resolved.get(part.id);
    if (existing) return existing;
    if (!part.snap || !byId.has(part.snap.targetId) || active.has(part.id)) {
      const position = { x: part.x, y: part.y }; resolved.set(part.id, position); return position;
    }
    active.add(part.id);
    const target = byId.get(part.snap.targetId)!;
    const targetPosition = resolve(target);
    const own = anchorPoint(primitiveBounds(part), part.snap.ownAnchor);
    const targetBounds = translatedBounds(primitiveBounds(target), targetPosition);
    const targetPoint = anchorPoint(targetBounds, part.snap.targetAnchor);
    const position = { x: targetPoint.x - own.x + part.snap.offset.x, y: targetPoint.y - own.y + part.snap.offset.y };
    active.delete(part.id); resolved.set(part.id, position); return position;
  };
  parts.forEach(resolve);
  return resolved;
}

export function primitiveBounds(part: PrimitiveEditor) {
  const points = shapePoints(primitiveShape(part)).map((point) => transformPoint(point, part.rotation, 0, 0));
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function anchorPoint(bounds: ReturnType<typeof primitiveBounds>, anchor: AnchorName): Point {
  const x = (bounds.minX + bounds.maxX) / 2, y = (bounds.minY + bounds.maxY) / 2;
  const values: Record<AnchorName, Point> = {
    center: { x, y }, top: { x, y: bounds.maxY }, bottom: { x, y: bounds.minY },
    left: { x: bounds.minX, y }, right: { x: bounds.maxX, y },
    top_left: { x: bounds.minX, y: bounds.maxY }, top_right: { x: bounds.maxX, y: bounds.maxY },
    bottom_left: { x: bounds.minX, y: bounds.minY }, bottom_right: { x: bounds.maxX, y: bounds.minY },
  };
  return values[anchor];
}

function translatedBounds(bounds: ReturnType<typeof primitiveBounds>, translation: Point) {
  return { minX: bounds.minX + translation.x, maxX: bounds.maxX + translation.x, minY: bounds.minY + translation.y, maxY: bounds.maxY + translation.y };
}

export function cloneItemAtParameter(item: EditorItem, parameterKey: string, value: number): EditorItem {
  const clone = structuredClone(item);
  const [kind, itemId, indexText] = parameterKey.split(":");
  if (itemId !== item.id) return clone;
  const part = clone.parts[Number(indexText)];
  if (!part) return clone;
  if (kind === "part_width") {
    if (part.kind === "rectangle") part.width = value;
    else if (part.kind === "triangle") part.base = value;
    else if (part.kind === "polygon") scalePolygonAxis(part.vertices, value, "x");
  } else if (kind === "part_height") {
    if (part.kind === "rectangle" || part.kind === "triangle") part.height = value;
    else if (part.kind === "polygon") scalePolygonAxis(part.vertices, value, "y");
  } else if (kind === "part_radius" && part.kind === "circle") part.radius = value;
  else if (kind === "part_scale") scalePrimitive(part, value);
  else if (kind === "item_scale") clone.parts.forEach((entry) => { entry.x *= value; entry.y *= value; if (entry.snap) { entry.snap.offset.x *= value; entry.snap.offset.y *= value; } scalePrimitive(entry, value); });
  return clone;
}

function scalePolygonAxis(points: Point[], target: number, axis: "x" | "y"): void {
  const values = points.map((point) => point[axis]); const min = Math.min(...values), size = Math.max(...values) - min;
  if (size > 0) points.forEach((point) => { point[axis] = min + (point[axis] - min) * target / size; });
}

function scalePrimitive(part: PrimitiveEditor, scale: number): void {
  if (part.kind === "rectangle") { part.width *= scale; part.height *= scale; }
  else if (part.kind === "triangle") { part.base *= scale; part.height *= scale; }
  else if (part.kind === "circle") part.radius *= scale;
  else part.vertices.forEach((point) => { point.x *= scale; point.y *= scale; });
}

let partSequence = 0;
function nextPartId(): string { partSequence += 1; return `part-${partSequence}`; }
