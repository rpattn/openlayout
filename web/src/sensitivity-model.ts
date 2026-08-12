import { cloneItemAtParameter, primitiveShape, scalePrimitive, shapePoints } from "./problem";
import type { EditorState, ParameterPath, PrimitiveEditor } from "./types";

export interface ParameterChoice { key: string; label: string; group: string }

export function parameterCatalog(state: EditorState): ParameterChoice[] {
  const options: ParameterChoice[] = [];
  const add = (key: string, label: string, group: string) => options.push({ key, label, group });
  state.items.forEach((item) => {
    add(`item_scale:${item.id}`, `${item.id} · whole shape scale`, "Packable shapes");
    add(`item_quantity:${item.id}`, `${item.id} · quantity`, "Packable shapes");
    item.parts.forEach((part, index) => {
      add(`part_scale:${item.id}:${index}`, `${item.id} · ${part.id} scale`, "Packable shapes");
      if (part.kind === "rectangle" || part.kind === "triangle" || part.kind === "polygon" || part.kind === "bezier") {
        add(`part_width:${item.id}:${index}`, `${item.id} · ${part.id} width/base`, "Packable shapes");
        add(`part_height:${item.id}:${index}`, `${item.id} · ${part.id} height`, "Packable shapes");
      }
      if (part.kind === "circle") add(`part_radius:${item.id}:${index}`, `${item.id} · ${part.id} radius`, "Packable shapes");
    });
  });
  state.containerParts.forEach((part) => {
    add(`container_part_scale:${part.id}`, `${part.id} · scale`, "Container");
    add(`container_part_width:${part.id}`, `${part.id} · width`, "Container");
    add(`container_part_height:${part.id}`, `${part.id} · height`, "Container");
  });
  add("clearance_item_to_item", "Item-to-item clearance", "Constraints");
  add("clearance_item_to_boundary", "Boundary clearance", "Constraints");
  add("container_width", "Container width", "Container");
  add("container_height", "Container height", "Container");
  state.exclusions.forEach((entry) => add(`exclusion_scale:${entry.id}`, `${entry.id} · scale`, "Keep-out regions"));
  return options;
}

export function parameterCurrentValue(state: EditorState, key: string): number {
  const [kind, id, rawIndex] = key.split(":");
  if (kind === "clearance_item_to_item") return state.clearance.item_to_item;
  if (kind === "clearance_item_to_boundary") return state.clearance.item_to_boundary;
  if (kind === "item_quantity") return state.items.find((item) => item.id === id)?.quantity ?? 0;
  if (kind === "item_scale" || kind === "part_scale" || kind === "container_part_scale" || kind === "exclusion_scale") return 1;
  let part: PrimitiveEditor | undefined;
  if (kind.startsWith("part_")) part = state.items.find((item) => item.id === id)?.parts[Number(rawIndex)];
  else if (kind.startsWith("container_part_")) part = state.containerParts.find((entry) => entry.id === id)?.primitive;
  else if (kind === "container_width" || kind === "container_height") part = state.containerParts.find((entry) => entry.operation === "add")?.primitive;
  if (!part) return 0;
  if (kind.endsWith("radius") && part.kind === "circle") return part.radius;
  const points = shapePoints(primitiveShape(part));
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  return kind.endsWith("height") ? height : width;
}

export function stateAtParameter(state: EditorState, value: number): EditorState {
  const clone = structuredClone(state);
  const [kind, id] = clone.study.parameterKey.split(":");
  const itemIndex = clone.items.findIndex((item) => item.id === id);
  if (itemIndex >= 0 && (kind.startsWith("part_") || kind === "item_scale")) {
    clone.items[itemIndex] = cloneItemAtParameter(clone.items[itemIndex], clone.study.parameterKey, value);
  } else if (kind === "item_quantity" && itemIndex >= 0) clone.items[itemIndex].quantity = Math.max(0, Math.round(value));
  else if (kind.startsWith("container_part_")) {
    const part = clone.containerParts.find((entry) => entry.id === id)?.primitive;
    if (part) applyPrimitiveParameter(part, kind.replace("container_part_", ""), value);
  } else if (kind === "container_width" || kind === "container_height") {
    const part = clone.containerParts.find((entry) => entry.operation === "add")?.primitive;
    if (part) applyPrimitiveParameter(part, kind === "container_width" ? "width" : "height", value);
  } else if (kind === "exclusion_scale") clone.exclusions.find((entry) => entry.id === id)?.parts.forEach((part) => scalePrimitive(part, value));
  else if (kind === "clearance_item_to_item") clone.clearance.item_to_item = value;
  else if (kind === "clearance_item_to_boundary") clone.clearance.item_to_boundary = value;
  return clone;
}

export function decodeParameter(key: string): ParameterPath {
  const [kind, id, index] = key.split(":");
  if (kind === "part_width") return { kind: "item_part_width", item_id: id, part_index: Number(index) };
  if (kind === "part_height") return { kind: "item_part_height", item_id: id, part_index: Number(index) };
  if (kind === "part_radius") return { kind: "item_part_radius", item_id: id, part_index: Number(index) };
  if (kind === "part_scale") return { kind: "item_part_scale", item_id: id, part_index: Number(index) };
  if (kind === "item_scale") return { kind: "item_scale", item_id: id };
  if (kind === "item_quantity") return { kind: "item_quantity", item_id: id };
  if (kind === "container_part_width") return { kind: "container_part_width", part_id: id };
  if (kind === "container_part_height") return { kind: "container_part_height", part_id: id };
  if (kind === "container_part_scale") return { kind: "container_part_scale", part_id: id };
  if (kind === "exclusion_scale") return { kind: "exclusion_scale", exclusion_id: id };
  if (kind === "clearance_item_to_item" || kind === "clearance_item_to_boundary" || kind === "container_width") return { kind };
  return { kind: "container_height" };
}

export function studyValues(start: number, end: number, step: number, limit = 6): number[] {
  const values = [start];
  if (step > 0) for (let value = start + step; value < end && values.length < limit; value += step) values.push(value);
  if (end !== start) values.push(end);
  return values;
}

function applyPrimitiveParameter(part: PrimitiveEditor, kind: string, value: number): void {
  if (kind === "scale") { scalePrimitive(part, value); return; }
  if (kind === "width") {
    if (part.kind === "rectangle") part.width = value;
    else if (part.kind === "triangle") part.base = value;
    else scaleAxis(part, "x", value);
  } else if (kind === "height") {
    if (part.kind === "rectangle" || part.kind === "triangle") part.height = value;
    else scaleAxis(part, "y", value);
  }
}

function scaleAxis(part: PrimitiveEditor, axis: "x" | "y", target: number): void {
  const points = part.kind === "polygon" ? part.vertices : part.kind === "bezier" ? part.knots.flatMap((knot) => [knot.point, knot.control_in, knot.control_out]) : [];
  if (!points.length) return;
  const values = points.map((point) => point[axis]);
  const min = Math.min(...values), span = Math.max(...values) - min;
  if (span > 0) points.forEach((point) => { point[axis] = min + (point[axis] - min) * target / span; });
}
