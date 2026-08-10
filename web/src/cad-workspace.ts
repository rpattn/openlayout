import { primitiveAnchor, primitiveShape, resolveEditorTranslations, shapePoints, toProblem, transformPoint } from "./problem";
import type { AnchorName, EditorState, PackingProblem, Placement, Point, PrimitiveEditor, Shape, ShapePart } from "./types";

const ITEM_COLORS = ["#51c6a4", "#f2b65d", "#7ba4f8", "#d98adf", "#ee716f", "#94c973"];
const ANCHORS: AnchorName[] = ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"];

export type CadSelection =
  | { kind: "container"; index: number }
  | { kind: "exclusion"; index: number }
  | { kind: "item"; index: number }
  | { kind: "placement"; index: number };

interface Bounds { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
interface View { minX: number; minY: number; width: number; height: number }
interface Drag {
  mode: "pan" | "placement" | "rotate" | "definition" | "definition-rotate" | "definition-scale" | "geometry" | "snap-offset" | "part-move";
  startClient: Point;
  startWorld: Point;
  originalView?: View;
  placementIndex?: number;
  originalPlacement?: Placement;
  selection?: Exclude<CadSelection, { kind: "placement" }>;
  originalState?: EditorState;
  center?: Point;
  rotation?: number;
  partIndex?: number;
  geometryHandle?: string;
  moved: boolean;
}

export interface CadWorkspaceCallbacks {
  onSelect(selection: CadSelection | null, partIndex?: number): void;
  onDefinitionChange(selection: Exclude<CadSelection, { kind: "placement" }>, previous: EditorState): void;
  onPlacementChange(index: number): void;
}

export class CadWorkspace {
  private state: EditorState;
  private problem: PackingProblem;
  private placements: Placement[] = [];
  private selection: CadSelection | null = null;
  private selectedPartIndex = 0;
  private view: View = { minX: -20, minY: -12, width: 40, height: 24 };
  private drag: Drag | null = null;
  private dimensions = false;
  private clearance = false;
  private fitted = false;
  private readonly sampleOffsets = new Map<string, Point>();

  constructor(
    private readonly svg: SVGSVGElement,
    state: EditorState,
    problem: PackingProblem,
    private readonly callbacks: CadWorkspaceCallbacks,
  ) {
    this.state = state;
    this.problem = problem;
    this.bind();
    this.fit();
  }

  destroy(): void {
    this.svg.replaceWith(this.svg.cloneNode(false));
  }

  setModel(state: EditorState, problem: PackingProblem, placements: Placement[], refit = false): void {
    this.state = state;
    this.problem = problem;
    this.placements = placements;
    if (refit) this.sampleOffsets.clear();
    if (refit || !this.fitted) this.fit(); else this.render();
  }

  setSelection(selection: CadSelection | null, partIndex = this.selectedPartIndex): void {
    this.selection = selection;
    this.selectedPartIndex = partIndex;
    this.render();
  }

  setOverlays(dimensions: boolean, clearance: boolean): void {
    this.dimensions = dimensions;
    this.clearance = clearance;
    this.render();
  }

  zoom(factor: number, center?: Point): void {
    const focus = center ?? { x: this.view.minX + this.view.width / 2, y: this.view.minY + this.view.height / 2 };
    const nextWidth = clamp(this.view.width * factor, 2, 1000);
    const nextHeight = nextWidth * this.view.height / this.view.width;
    const ratioX = (focus.x - this.view.minX) / this.view.width;
    const ratioY = (focus.y - this.view.minY) / this.view.height;
    this.view = { minX: focus.x - nextWidth * ratioX, minY: focus.y - nextHeight * ratioY, width: nextWidth, height: nextHeight };
    this.render();
  }

  fit(): void {
    const bounds = this.sceneBounds();
    const aspect = Math.max(this.svg.clientWidth, 1) / Math.max(this.svg.clientHeight, 1);
    const padding = Math.max(bounds.width, bounds.height) * .08 + 1.2;
    let width = Math.max(bounds.width + padding * 2, 8);
    let height = Math.max(bounds.height + padding * 2, 6);
    if (width / height > aspect) height = width / aspect; else width = height * aspect;
    this.view = { minX: (bounds.minX + bounds.maxX - width) / 2, minY: (bounds.minY + bounds.maxY - height) / 2, width, height };
    this.fitted = true;
    this.render();
  }

  focusSelection(): void {
    if (!this.selection) return;
    const bounds = this.selectionBounds(this.selection); if (!bounds) return;
    const aspect = Math.max(this.svg.clientWidth, 1) / Math.max(this.svg.clientHeight, 1);
    const padding = Math.max(bounds.width, bounds.height) * .42 + .8;
    let width = Math.max(bounds.width + padding * 2, 3), height = Math.max(bounds.height + padding * 2, 3);
    if (width / height > aspect) height = width / aspect; else width = height * aspect;
    this.view = { minX: (bounds.minX + bounds.maxX - width) / 2, minY: (bounds.minY + bounds.maxY - height) / 2, width, height };
    this.render();
  }

  private bind(): void {
    this.svg.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.svg.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.svg.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.svg.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.svg.addEventListener("dblclick", (event) => {
      const target = (event.target as Element).closest<SVGElement>("[data-cad-kind]"); if (!target) return;
      const selection = selectionFrom(target); this.selection = selection;
      const partIndex = selection.kind === "item" ? Number(target.dataset.cadPart ?? 0) : undefined;
      if (partIndex !== undefined) this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(selection, partIndex); this.focusSelection();
    });
    this.svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoom(event.deltaY > 0 ? 1.12 : .88, this.eventPoint(event));
    }, { passive: false });
  }

  private render(): void {
    const y = -this.view.minY - this.view.height;
    this.svg.setAttribute("viewBox", `${this.view.minX} ${y} ${this.view.width} ${this.view.height}`);
    const scale = this.view.width / Math.max(this.svg.clientWidth, 1);
    const samples = this.itemSamples();
    this.svg.innerHTML = `<rect class="cad-background" data-cad-background x="${this.view.minX}" y="${y}" width="${this.view.width}" height="${this.view.height}"/>
      <g class="cad-grid">${gridMarkup(this.view)}</g>
      <g class="cad-container">${this.problem.container.parts.map((part, index) => {
        const selected = this.selection?.kind === "container" && this.selection.index === index;
        return polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path data-cad-kind="container" data-cad-index="${index}" class="cad-region ${part.operation} ${selected ? "selected" : ""}" d="${path(polygon)}"/>`).join("");
      }).join("")}</g>
      ${this.clearance ? this.containerClearanceMarkup() : ""}
      <g class="cad-exclusions">${this.problem.exclusions.map((entry, index) => {
        const selected = this.selection?.kind === "exclusion" && this.selection.index === index;
        return polygons(entry.shape).map((polygon) => `<path data-cad-kind="exclusion" data-cad-index="${index}" class="cad-exclusion ${selected ? "selected" : ""}" d="${path(polygon)}"/>`).join("");
      }).join("")}</g>
      ${this.clearance ? this.exclusionClearanceMarkup() : ""}
      <g class="cad-placements">${this.placements.map((placement, index) => this.placementMarkup(placement, index)).join("")}</g>
      <g class="cad-library">${samples.map((sample, index) => this.itemSampleMarkup(sample, index)).join("")}</g>
      ${this.dimensions ? this.dimensionMarkup() : ""}
      ${this.selection ? this.selectionHandles(this.selection, scale) : ""}`;
  }

  private pointerDown(event: PointerEvent): void {
    const snapHandle = (event.target as Element).closest<SVGElement>("[data-snap-offset-handle]");
    if (snapHandle) {
      const definition = parseDefinitionKey(snapHandle.dataset.snapOffsetHandle!);
      const partIndex = Number(snapHandle.dataset.snapPart ?? 0);
      this.selection = definition; this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(definition, partIndex);
      this.drag = {
        mode: "snap-offset", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, partIndex, originalState: structuredClone(this.state), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const partMove = (event.target as Element).closest<SVGElement>("[data-part-move]");
    if (partMove) {
      const definition = parseDefinitionKey(partMove.dataset.partMove!);
      const partIndex = Number(partMove.dataset.partIndex ?? 0);
      this.selection = definition; this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(definition, partIndex);
      this.drag = {
        mode: "part-move", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, partIndex, originalState: structuredClone(this.state), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const geometryHandle = (event.target as Element).closest<SVGElement>("[data-geometry-handle]");
    if (geometryHandle) {
      const definition = parseDefinitionKey(geometryHandle.dataset.geometryTarget!);
      const partIndex = Number(geometryHandle.dataset.geometryPart ?? 0);
      const context = this.primitiveContext(definition, partIndex);
      if (!context) return;
      this.selection = definition;
      this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(definition, partIndex);
      this.drag = {
        mode: "geometry", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, originalState: structuredClone(this.state), center: context.center, rotation: context.rotation,
        partIndex, geometryHandle: geometryHandle.dataset.geometryHandle, moved: false,
      };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const scaleHandle = (event.target as Element).closest<SVGElement>("[data-definition-scale]");
    if (scaleHandle) {
      const definition = parseDefinitionKey(scaleHandle.dataset.definitionScale!);
      const center = this.definitionCenter(definition);
      this.selection = definition;
      this.callbacks.onSelect(definition, definition.kind === "item" ? this.selectedPartIndex : undefined);
      this.drag = {
        mode: "definition-scale", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, originalState: structuredClone(this.state), center, moved: false,
      };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const handle = (event.target as Element).closest<SVGElement>("[data-placement-rotate]");
    if (handle) {
      const index = Number(handle.dataset.placementRotate);
      const placement = this.placements[index];
      if (!placement) return;
      this.selection = { kind: "placement", index };
      this.callbacks.onSelect(this.selection);
      this.drag = { mode: "rotate", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), placementIndex: index, originalPlacement: { ...placement }, moved: false };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const definitionHandle = (event.target as Element).closest<SVGElement>("[data-definition-rotate]");
    if (definitionHandle) {
      const definition = parseDefinitionKey(definitionHandle.dataset.definitionRotate!);
      const center = this.definitionCenter(definition);
      this.selection = definition;
      this.callbacks.onSelect(definition);
      this.drag = {
        mode: "definition-rotate", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, originalState: structuredClone(this.state), center, moved: false,
      };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const target = (event.target as Element).closest<SVGElement>("[data-cad-kind]");
    const selection = target ? selectionFrom(target) : null;
    if (selection) {
      this.selection = selection;
      const partIndex = selection.kind === "item" ? Number(target?.dataset.cadPart ?? 0) : undefined;
      if (partIndex !== undefined) this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(selection, partIndex);
      if (selection.kind === "placement") {
        const placement = this.placements[selection.index];
        this.drag = { mode: "placement", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), placementIndex: selection.index, originalPlacement: { ...placement }, moved: false };
        this.svg.setPointerCapture(event.pointerId);
      } else {
        this.drag = {
          mode: "definition", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
          selection, originalState: structuredClone(this.state), center: this.definitionCenter(selection), moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
        this.render();
      }
      return;
    }
    this.selection = null;
    this.callbacks.onSelect(null);
    this.drag = { mode: "pan", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), originalView: { ...this.view }, moved: false };
    this.svg.setPointerCapture(event.pointerId);
    this.render();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.drag) return;
    if (this.drag.mode === "pan") {
      const pixelsToWorld = this.drag.originalView!.width / Math.max(this.svg.clientWidth, 1);
      this.view.minX = this.drag.originalView!.minX - (event.clientX - this.drag.startClient.x) * pixelsToWorld;
      this.view.minY = this.drag.originalView!.minY + (event.clientY - this.drag.startClient.y) * pixelsToWorld;
      this.drag.moved = true;
      this.render();
      return;
    }
    if (this.drag.mode === "definition" || this.drag.mode === "definition-rotate" || this.drag.mode === "definition-scale" || this.drag.mode === "geometry" || this.drag.mode === "snap-offset" || this.drag.mode === "part-move") {
      const selection = this.drag.selection!;
      const current = this.eventPoint(event);
      if (this.drag.mode === "definition") {
        this.moveDefinition(selection, this.drag.originalState!, current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y);
      } else if (this.drag.mode === "definition-rotate") {
        const center = this.drag.center!;
        const start = Math.atan2(this.drag.startWorld.y - center.y, this.drag.startWorld.x - center.x);
        const angle = Math.atan2(current.y - center.y, current.x - center.x);
        this.rotateDefinition(selection, this.drag.originalState!, (angle - start) * 180 / Math.PI);
      } else if (this.drag.mode === "definition-scale") {
        const center = this.drag.center!;
        const startDistance = Math.max(Math.hypot(this.drag.startWorld.x - center.x, this.drag.startWorld.y - center.y), 1e-6);
        const factor = clamp(Math.hypot(current.x - center.x, current.y - center.y) / startDistance, .02, 50);
        this.scaleDefinition(selection, this.drag.originalState!, factor);
      } else if (this.drag.mode === "snap-offset") {
        const before = primitiveFor(this.drag.originalState!, selection, this.drag.partIndex!);
        const part = primitiveFor(this.state, selection, this.drag.partIndex!);
        if (before?.snap && part?.snap) part.snap.offset = {
          x: round(before.snap.offset.x + current.x - this.drag.startWorld.x),
          y: round(before.snap.offset.y + current.y - this.drag.startWorld.y),
        };
      } else if (this.drag.mode === "part-move") {
        this.movePart(selection, this.drag.originalState!, this.drag.partIndex!, current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y);
      } else {
        this.editDefinitionGeometry(selection, this.drag.originalState!, this.drag.partIndex!, this.drag.geometryHandle!, current, this.drag.center!, this.drag.rotation!);
      }
      this.problem = toProblem(this.state);
      this.drag.moved = true;
      this.render();
      return;
    }
    const index = this.drag.placementIndex!;
    const placement = this.placements[index];
    const original = this.drag.originalPlacement!;
    const current = this.eventPoint(event);
    if (this.drag.mode === "placement") {
      placement.x = round(original.x + current.x - this.drag.startWorld.x);
      placement.y = round(original.y + current.y - this.drag.startWorld.y);
    } else {
      const start = Math.atan2(this.drag.startWorld.y - original.y, this.drag.startWorld.x - original.x);
      const angle = Math.atan2(current.y - original.y, current.x - original.x);
      placement.rotation_deg = round(original.rotation_deg + (angle - start) * 180 / Math.PI, 1);
    }
    this.drag.moved = true;
    this.render();
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    if (drag.moved && drag.mode === "part-move" && drag.selection && drag.partIndex !== undefined) this.snapMovedPart(drag.selection, drag.partIndex);
    if (drag.moved && drag.placementIndex !== undefined) this.callbacks.onPlacementChange(drag.placementIndex);
    if (drag.moved && drag.selection && drag.originalState) this.callbacks.onDefinitionChange(drag.selection, drag.originalState);
  }

  private eventPoint(event: MouseEvent | PointerEvent | WheelEvent): Point {
    const point = this.svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(this.svg.getScreenCTM()!.inverse());
    return { x: local.x, y: -local.y };
  }

  private placementMarkup(placement: Placement, index: number): string {
    const itemIndex = this.problem.items.findIndex((entry) => entry.id === placement.item_id);
    const item = this.problem.items[itemIndex];
    if (!item) return "";
    const color = ITEM_COLORS[Math.max(itemIndex, 0) % ITEM_COLORS.length];
    const selected = this.selection?.kind === "placement" && this.selection.index === index;
    const paths = polygons(item.shape, placement.rotation_deg, placement.x, placement.y).map((polygon) => `<path data-cad-kind="placement" data-cad-index="${index}" class="cad-placement ${selected ? "selected" : ""} ${placement.fixed ? "fixed" : ""}" style="--item-color:${color}" d="${path(polygon)}"/>`).join("");
    return `<g aria-label="${escapeHtml(placement.item_id)} placement ${index + 1}">${paths}</g>`;
  }

  private itemSampleMarkup(sample: ItemSample, index: number): string {
    const color = ITEM_COLORS[index % ITEM_COLORS.length];
    const selected = this.selection?.kind === "item" && this.selection.index === index;
    const padding = Math.max(sample.bounds.width, sample.bounds.height) * .2 + .35;
    return `${sample.polygons.map((polygon, partIndex) => `<path data-cad-kind="item" data-cad-index="${index}" data-cad-part="${partIndex}" class="cad-item-sample ${selected ? "selected" : ""}" style="--item-color:${color}" d="${path(polygon)}"/>`).join("")}
      <text class="cad-label" x="${sample.bounds.minX}" y="${-sample.bounds.maxY - padding}">${escapeHtml(this.problem.items[index].id)} · ${this.problem.items[index].quantity} requested</text>`;
  }

  private selectionHandles(selection: CadSelection, scale: number): string {
    const bounds = this.selectionBounds(selection);
    if (!bounds) return "";
    const offset = Math.max(24 * scale, .5);
    const top = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY };
    const handle = { x: top.x, y: top.y + offset };
    const attribute = selection.kind === "placement"
      ? `data-placement-rotate="${selection.index}"`
      : `data-definition-rotate="${selection.kind}:${selection.index}"`;
    const geometry = selection.kind === "placement" ? "" : this.geometryHandles(selection, scale);
    const snap = selection.kind === "item" || selection.kind === "container" ? this.snapMarkup(selection, scale) : "";
    const resize = selection.kind === "placement" ? "" : `<circle class="cad-global-scale-handle" data-definition-scale="${selection.kind}:${selection.index}" cx="${bounds.maxX}" cy="${-bounds.minY}" r="${Math.max(4.5 * scale, .09)}"/>`;
    return `<g class="cad-selection-handles">${snap}${geometry}${resize}<line x1="${top.x}" y1="${-top.y}" x2="${handle.x}" y2="${-handle.y}"/><circle class="cad-rotate-handle" ${attribute} cx="${handle.x}" cy="${-handle.y}" r="${Math.max(5 * scale, .1)}"/></g>`;
  }

  private snapMarkup(selection: Extract<CadSelection, { kind: "item" | "container" }>, scale: number): string {
    const parts = selection.kind === "item" ? this.state.items[selection.index]?.parts : this.state.containerParts.map((entry) => entry.primitive);
    const partIndex = selection.kind === "item" ? this.selectedPartIndex : selection.index;
    const part = parts?.[partIndex];
    if (!parts || !part?.snap) return "";
    const target = parts.find((entry) => entry.id === part.snap!.targetId);
    if (!target) return "";
    const translations = resolveEditorTranslations(parts);
    const ownPosition = translations.get(part.id) ?? { x: part.x, y: part.y };
    const targetPosition = translations.get(target.id) ?? { x: target.x, y: target.y };
    const ownAnchor = primitiveAnchor(part, part.snap.ownAnchor, ownPosition);
    const targetAnchor = primitiveAnchor(target, part.snap.targetAnchor, targetPosition);
    if (selection.kind === "item") this.itemSamples();
    const offset = selection.kind === "item" ? this.sampleOffsets.get(this.state.items[selection.index].id) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    const own = { x: ownAnchor.x + offset.x, y: ownAnchor.y + offset.y };
    const destination = { x: targetAnchor.x + offset.x, y: targetAnchor.y + offset.y };
    const targetCenter = { x: targetPosition.x + offset.x, y: targetPosition.y + offset.y };
    const ownCenter = { x: ownPosition.x + offset.x, y: ownPosition.y + offset.y };
    const radius = Math.max(4.5 * scale, .09);
    return `<g class="cad-snap-constraint"><line x1="${targetCenter.x}" y1="${-targetCenter.y}" x2="${ownCenter.x}" y2="${-ownCenter.y}"/><line class="cad-snap-offset" x1="${destination.x}" y1="${-destination.y}" x2="${own.x}" y2="${-own.y}"/><circle cx="${destination.x}" cy="${-destination.y}" r="${radius}"/><circle class="own" data-snap-offset-handle="${selection.kind}:${selection.index}" data-snap-part="${partIndex}" cx="${own.x}" cy="${-own.y}" r="${radius}"/></g>`;
  }

  private geometryHandles(selection: Exclude<CadSelection, { kind: "placement" }>, scale: number): string {
    const partIndex = selection.kind === "item" ? this.selectedPartIndex : selection.kind === "container" ? selection.index : 0;
    const context = this.primitiveContext(selection, partIndex);
    if (!context) return "";
    const primitive = context.primitive;
    const handles: Array<{ key: string; point: Point; className?: string }> = [];
    let guides = "";
    if (primitive.kind === "rectangle") {
      const x = primitive.width / 2, y = primitive.height / 2;
      handles.push(
        { key: "resize:left", point: { x: -x, y: 0 } }, { key: "resize:right", point: { x, y: 0 } },
        { key: "resize:top", point: { x: 0, y } }, { key: "resize:bottom", point: { x: 0, y: -y } },
        { key: "resize:top_left", point: { x: -x, y } }, { key: "resize:top_right", point: { x, y } },
        { key: "resize:bottom_left", point: { x: -x, y: -y } }, { key: "resize:bottom_right", point: { x, y: -y } },
      );
    } else if (primitive.kind === "triangle") {
      handles.push({ key: "base", point: { x: -primitive.base / 2, y: -primitive.height / 2 } }, { key: "base", point: { x: primitive.base / 2, y: -primitive.height / 2 } }, { key: "height", point: { x: 0, y: primitive.height / 2 } });
    } else if (primitive.kind === "circle") {
      handles.push({ key: "radius", point: { x: primitive.radius, y: 0 } }, { key: "radius", point: { x: -primitive.radius, y: 0 } }, { key: "radius", point: { x: 0, y: primitive.radius } }, { key: "radius", point: { x: 0, y: -primitive.radius } });
    } else if (primitive.kind === "polygon") {
      primitive.vertices.forEach((point, index) => handles.push({ key: `vertex:${index}`, point }));
    } else {
      primitive.knots.forEach((knot, index) => {
        const point = transformPoint(knot.point, context.rotation, context.center.x, context.center.y);
        const incoming = transformPoint(knot.control_in, context.rotation, context.center.x, context.center.y);
        const outgoing = transformPoint(knot.control_out, context.rotation, context.center.x, context.center.y);
        guides += `<line class="cad-bezier-tangent" x1="${incoming.x}" y1="${-incoming.y}" x2="${outgoing.x}" y2="${-outgoing.y}"/>`;
        handles.push({ key: `control_in:${index}`, point: knot.control_in, className: "control" }, { key: `knot:${index}`, point: knot.point, className: "knot" }, { key: `control_out:${index}`, point: knot.control_out, className: "control" });
        void point;
      });
    }
    const radius = Math.max(3.8 * scale, .075);
    const target = `${selection.kind}:${selection.index}`;
    const centerHandle = `<circle class="cad-part-move-handle" data-part-move="${target}" data-part-index="${partIndex}" cx="${context.center.x}" cy="${-context.center.y}" r="${Math.max(3.5 * scale, .07)}"/>`;
    const controls = handles.map((entry) => {
      const point = transformPoint(entry.point, context.rotation, context.center.x, context.center.y);
      return `<circle class="cad-geometry-handle ${entry.className ?? ""}" data-geometry-target="${target}" data-geometry-part="${partIndex}" data-geometry-handle="${entry.key}" cx="${point.x}" cy="${-point.y}" r="${radius}"/>`;
    }).join("");
    return `${this.editDimensionsMarkup(context, scale)}${guides}${centerHandle}${controls}`;
  }

  private editDimensionsMarkup(context: { primitive: PrimitiveEditor; center: Point; rotation: number }, scale: number): string {
    const points = shapePoints(primitiveShape(context.primitive));
    if (!points.length) return "";
    const bounds = pointBounds(points), offset = Math.max(18 * scale, .32), tick = Math.max(5 * scale, .09);
    const world = (point: Point) => transformPoint(point, context.rotation, context.center.x, context.center.y);
    const topLeft = world({ x: bounds.minX, y: bounds.maxY }), topRight = world({ x: bounds.maxX, y: bounds.maxY }), bottomRight = world({ x: bounds.maxX, y: bounds.minY });
    const widthA = world({ x: bounds.minX, y: bounds.maxY + offset }), widthB = world({ x: bounds.maxX, y: bounds.maxY + offset });
    const heightA = world({ x: bounds.maxX + offset, y: bounds.minY }), heightB = world({ x: bounds.maxX + offset, y: bounds.maxY });
    const widthMid = { x: (widthA.x + widthB.x) / 2, y: (widthA.y + widthB.y) / 2 };
    const heightMid = { x: (heightA.x + heightB.x) / 2, y: (heightA.y + heightB.y) / 2 };
    const verticalTick = (point: Point) => {
      const a = world({ x: inverseTransformPoint(point, context.rotation, context.center.x, context.center.y).x, y: bounds.maxY + offset - tick });
      const b = world({ x: inverseTransformPoint(point, context.rotation, context.center.x, context.center.y).x, y: bounds.maxY + offset + tick });
      return `<line x1="${a.x}" y1="${-a.y}" x2="${b.x}" y2="${-b.y}"/>`;
    };
    const fontSize = Math.max(10 * scale, .16);
    const halo = Math.max(2.5 * scale, .04);
    return `<g class="cad-edit-dimensions"><line class="extension" x1="${topLeft.x}" y1="${-topLeft.y}" x2="${widthA.x}" y2="${-widthA.y}"/><line class="extension" x1="${topRight.x}" y1="${-topRight.y}" x2="${widthB.x}" y2="${-widthB.y}"/><line x1="${widthA.x}" y1="${-widthA.y}" x2="${widthB.x}" y2="${-widthB.y}"/>${verticalTick(widthA)}${verticalTick(widthB)}<text transform="translate(${widthMid.x} ${-widthMid.y}) rotate(${-context.rotation})" y="${-4 * scale}" style="font-size:${fontSize}px;stroke-width:${halo}px">${format(bounds.width)}</text><line class="extension" x1="${topRight.x}" y1="${-topRight.y}" x2="${heightB.x}" y2="${-heightB.y}"/><line class="extension" x1="${bottomRight.x}" y1="${-bottomRight.y}" x2="${heightA.x}" y2="${-heightA.y}"/><line x1="${heightA.x}" y1="${-heightA.y}" x2="${heightB.x}" y2="${-heightB.y}"/><text transform="translate(${heightMid.x} ${-heightMid.y}) rotate(${-context.rotation - 90})" y="${-4 * scale}" style="font-size:${fontSize}px;stroke-width:${halo}px">${format(bounds.height)}</text></g>`;
  }

  private primitiveContext(selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): { primitive: PrimitiveEditor; center: Point; rotation: number } | null {
    if (selection.kind === "container") {
      const primitive = this.state.containerParts[selection.index]?.primitive;
      const rendered = this.problem.container.parts[selection.index];
      return primitive && rendered ? { primitive, center: rendered.translation, rotation: primitive.rotation } : null;
    }
    if (selection.kind === "exclusion") {
      const primitive = this.state.exclusions[selection.index]?.primitive;
      return primitive ? { primitive, center: { x: primitive.x, y: primitive.y }, rotation: primitive.rotation } : null;
    }
    const primitive = this.state.items[selection.index]?.parts[partIndex];
    const shape = this.problem.items[selection.index]?.shape;
    if (!primitive || shape?.kind !== "compound" || !shape.parts[partIndex]) return null;
    this.itemSamples();
    const offset = this.sampleOffsets.get(this.state.items[selection.index].id) ?? { x: 0, y: 0 };
    const translation = resolveShapePartTranslations(shape.parts)[partIndex];
    return { primitive, center: { x: translation.x + offset.x, y: translation.y + offset.y }, rotation: shape.parts[partIndex].rotation_deg };
  }

  private editDefinitionGeometry(
    selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, partIndex: number,
    handle: string, world: Point, center: Point, rotation: number,
  ): void {
    const target = primitiveFor(this.state, selection, partIndex);
    const source = primitiveFor(original, selection, partIndex);
    if (!target || !source || target.kind !== source.kind) return;
    const local = inverseTransformPoint(world, rotation, center.x, center.y);
    if (target.kind === "rectangle") {
      const anchor = handle.startsWith("resize:") ? handle.slice(7) : handle;
      if (anchor.includes("left") || anchor.includes("right") || anchor === "width") target.width = round(Math.max(.05, Math.abs(local.x) * 2));
      if (anchor.includes("top") || anchor.includes("bottom") || anchor === "height") target.height = round(Math.max(.05, Math.abs(local.y) * 2));
    } else if (target.kind === "triangle") {
      if (handle === "base") target.base = round(Math.max(.05, Math.abs(local.x) * 2));
      if (handle === "height") target.height = round(Math.max(.05, Math.abs(local.y) * 2));
    } else if (target.kind === "circle") {
      if (handle === "radius") target.radius = round(Math.max(.025, Math.hypot(local.x, local.y)));
    } else if (target.kind === "polygon" && handle.startsWith("vertex:")) {
      const index = Number(handle.split(":")[1]);
      if (target.vertices[index]) target.vertices[index] = { x: round(local.x), y: round(local.y) };
    } else if (target.kind === "bezier" && source.kind === "bezier" && handle.startsWith("knot:")) {
      const index = Number(handle.split(":")[1]);
      const knot = target.knots[index], before = source.knots[index];
      if (knot && before) {
        const dx = local.x - before.point.x, dy = local.y - before.point.y;
        knot.point = { x: round(local.x), y: round(local.y) };
        knot.control_in = { x: round(before.control_in.x + dx), y: round(before.control_in.y + dy) };
        knot.control_out = { x: round(before.control_out.x + dx), y: round(before.control_out.y + dy) };
      }
    } else if (target.kind === "bezier" && handle.startsWith("control_in:")) {
      const knot = target.knots[Number(handle.split(":")[1])]; if (knot) knot.control_in = { x: round(local.x), y: round(local.y) };
    } else if (target.kind === "bezier" && handle.startsWith("control_out:")) {
      const knot = target.knots[Number(handle.split(":")[1])]; if (knot) knot.control_out = { x: round(local.x), y: round(local.y) };
    }
  }

  private movePart(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, partIndex: number, dx: number, dy: number): void {
    const source = primitiveFor(original, selection, partIndex), target = primitiveFor(this.state, selection, partIndex);
    if (!source || !target) return;
    if (source.snap && target.snap) {
      target.snap.offset = { x: round(source.snap.offset.x + dx), y: round(source.snap.offset.y + dy) };
    } else {
      target.x = round(source.x + dx); target.y = round(source.y + dy);
    }
  }

  private snapMovedPart(selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): void {
    if (selection.kind === "exclusion") return;
    const parts = selection.kind === "item" ? this.state.items[selection.index]?.parts : this.state.containerParts.map((entry) => entry.primitive);
    const part = parts?.[partIndex]; if (!parts || !part || part.snap) return;
    const positions = resolveEditorTranslations(parts), ownPosition = positions.get(part.id) ?? { x: part.x, y: part.y };
    const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 14;
    let best: { targetId: string; ownAnchor: AnchorName; targetAnchor: AnchorName; distance: number } | null = null;
    parts.forEach((target) => {
      if (target.id === part.id || primitiveDependsOn(parts, target.id, part.id)) return;
      const targetPosition = positions.get(target.id) ?? { x: target.x, y: target.y };
      ANCHORS.forEach((ownAnchor) => ANCHORS.forEach((targetAnchor) => {
        const own = primitiveAnchor(part, ownAnchor, ownPosition), destination = primitiveAnchor(target, targetAnchor, targetPosition);
        const distance = Math.hypot(own.x - destination.x, own.y - destination.y);
        if (distance <= threshold && (!best || distance < best.distance)) best = { targetId: target.id, ownAnchor, targetAnchor, distance };
      }));
    });
    const candidate = best as { targetId: string; ownAnchor: AnchorName; targetAnchor: AnchorName; distance: number } | null;
    if (candidate) {
      part.snap = { targetId: candidate.targetId, ownAnchor: candidate.ownAnchor, targetAnchor: candidate.targetAnchor, offset: { x: 0, y: 0 } };
      this.problem = toProblem(this.state); this.render();
    }
  }

  private selectionBounds(selection: CadSelection): Bounds | null {
    if (selection.kind === "container") {
      const points = containerComponentIndices(this.state, selection.index).flatMap((index) => {
        const part = this.problem.container.parts[index];
        return part ? polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat() : [];
      });
      return points.length ? pointBounds(points) : null;
    }
    if (selection.kind === "exclusion") {
      const entry = this.problem.exclusions[selection.index];
      return entry ? pointBounds(polygons(entry.shape).flat()) : null;
    }
    if (selection.kind === "item") return this.itemSamples()[selection.index]?.bounds ?? null;
    const index = selection.index;
    const placement = this.placements[index];
    const item = placement && this.problem.items.find((entry) => entry.id === placement.item_id);
    if (!placement || !item) return null;
    const points = polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat();
    return pointBounds(points);
  }

  private dimensionMarkup(): string {
    const regions = this.problem.container.parts.flatMap((part) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y));
    return regions.map((polygon) => dimensionsFor(pointBounds(polygon), this.view.width / Math.max(this.svg.clientWidth, 1))).join("");
  }

  private containerClearanceMarkup(): string {
    const distance = this.problem.clearance.item_to_boundary;
    if (!distance) return "";
    return this.problem.container.parts.flatMap((part) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path class="cad-clearance" d="${path(offsetPolygon(polygon, part.operation === "add" ? -distance : distance))}"/>`)).join("");
  }

  private exclusionClearanceMarkup(): string {
    return this.problem.exclusions.flatMap((entry) => polygons(entry.shape).map((polygon) => {
      const distance = Math.max(this.problem.clearance.item_to_exclusion, entry.clearance);
      return distance ? `<path class="cad-clearance danger" d="${path(offsetPolygon(polygon, distance))}"/>` : "";
    })).join("");
  }

  private itemSamples(): ItemSample[] {
    const container = this.containerBounds();
    const gap = Math.max(container.width * .08, 2);
    let top = container.maxY;
    return this.problem.items.map((item) => {
      const local = polygons(item.shape);
      const bounds = pointBounds(local.flat());
      let offset = this.sampleOffsets.get(item.id);
      if (!offset) {
        offset = { x: container.maxX + gap - bounds.minX, y: top - bounds.maxY };
        this.sampleOffsets.set(item.id, offset);
      }
      const tx = offset.x;
      const ty = offset.y;
      const transformed = local.map((polygon) => polygon.map((point) => ({ x: point.x + tx, y: point.y + ty })));
      const resultBounds = pointBounds(transformed.flat());
      top = resultBounds.minY - Math.max(resultBounds.height * .55, 1.5);
      return { polygons: transformed, bounds: resultBounds };
    });
  }

  private definitionCenter(selection: Exclude<CadSelection, { kind: "placement" }>): Point {
    const bounds = this.selectionBounds(selection);
    return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
  }

  private moveDefinition(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, dx: number, dy: number): void {
    if (selection.kind === "container") {
      containerComponentIndices(original, selection.index).forEach((index) => {
        const source = original.containerParts[index]?.primitive, target = this.state.containerParts[index]?.primitive;
        if (source && target && !source.snap) { target.x = round(source.x + dx); target.y = round(source.y + dy); }
      });
      return;
    }
    if (selection.kind === "exclusion") {
      const source = original.exclusions[selection.index]?.primitive;
      const target = this.state.exclusions[selection.index]?.primitive;
      if (source && target) { target.x = round(source.x + dx); target.y = round(source.y + dy); }
      return;
    }
    const source = original.items[selection.index];
    const target = this.state.items[selection.index];
    if (!source || !target) return;
    target.parts.forEach((part, index) => {
      const before = source.parts[index];
      if (before && !before.snap) { part.x = round(before.x + dx); part.y = round(before.y + dy); }
    });
  }

  private rotateDefinition(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, delta: number): void {
    if (selection.kind === "container") {
      const indices = containerComponentIndices(original, selection.index), center = containerGeometryCenter(original, indices), radians = delta * Math.PI / 180;
      indices.forEach((index) => {
        const source = original.containerParts[index]?.primitive, target = this.state.containerParts[index]?.primitive; if (!source || !target) return;
        target.rotation = round(source.rotation + delta, 1);
        if (source.snap && target.snap) target.snap.offset = rotateVector(source.snap.offset, delta);
        else {
          const x = source.x - center.x, y = source.y - center.y;
          target.x = round(center.x + x * Math.cos(radians) - y * Math.sin(radians));
          target.y = round(center.y + x * Math.sin(radians) + y * Math.cos(radians));
        }
      });
      return;
    }
    if (selection.kind === "exclusion") {
      const source = original.exclusions[selection.index]?.primitive;
      const target = this.state.exclusions[selection.index]?.primitive;
      if (source && target) target.rotation = round(source.rotation + delta, 1);
      return;
    }
    const source = original.items[selection.index];
    const target = this.state.items[selection.index];
    if (!source || !target) return;
    const center = itemGeometryCenter(original, selection.index);
    const radians = delta * Math.PI / 180;
    target.parts.forEach((part, index) => {
      const before = source.parts[index];
      if (!before) return;
      part.rotation = round(before.rotation + delta, 1);
      if (!before.snap) {
        const x = before.x - center.x, y = before.y - center.y;
        part.x = round(center.x + x * Math.cos(radians) - y * Math.sin(radians));
        part.y = round(center.y + x * Math.sin(radians) + y * Math.cos(radians));
      } else {
        part.snap!.offset = rotateVector(before.snap.offset, delta);
      }
    });
  }

  private scaleDefinition(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, factor: number): void {
    if (selection.kind === "container") {
      const indices = containerComponentIndices(original, selection.index), center = containerGeometryCenter(original, indices);
      indices.forEach((index) => {
        const source = original.containerParts[index]?.primitive, target = this.state.containerParts[index]?.primitive; if (!source || !target) return;
        copyPrimitiveGeometry(target, source); scalePrimitiveGeometry(target, factor);
        if (source.snap && target.snap) target.snap.offset = { x: round(source.snap.offset.x * factor), y: round(source.snap.offset.y * factor) };
        else { target.x = round(center.x + (source.x - center.x) * factor); target.y = round(center.y + (source.y - center.y) * factor); }
      });
      return;
    }
    if (selection.kind === "exclusion") {
      const source = original.exclusions[selection.index]?.primitive, target = this.state.exclusions[selection.index]?.primitive;
      if (source && target) { copyPrimitiveGeometry(target, source); scalePrimitiveGeometry(target, factor); }
      return;
    }
    const source = original.items[selection.index], target = this.state.items[selection.index];
    if (!source || !target) return;
    const center = itemGeometryCenter(original, selection.index);
    target.parts.forEach((part, index) => {
      const before = source.parts[index]; if (!before) return;
      copyPrimitiveGeometry(part, before); scalePrimitiveGeometry(part, factor);
      if (!before.snap) {
        part.x = round(center.x + (before.x - center.x) * factor);
        part.y = round(center.y + (before.y - center.y) * factor);
      } else {
        part.snap!.offset = { x: round(before.snap.offset.x * factor), y: round(before.snap.offset.y * factor) };
      }
    });
  }

  private containerBounds(): Bounds {
    const points = this.problem.container.parts.flatMap((part) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat());
    return points.length ? pointBounds(points) : { minX: -10, minY: -7, maxX: 10, maxY: 7, width: 20, height: 14 };
  }

  private sceneBounds(): Bounds {
    const points = this.problem.container.parts.flatMap((part) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat());
    this.problem.exclusions.forEach((entry) => points.push(...polygons(entry.shape).flat()));
    this.itemSamples().forEach((sample) => points.push(...sample.polygons.flat()));
    this.placements.forEach((placement) => {
      const item = this.problem.items.find((entry) => entry.id === placement.item_id);
      if (item) points.push(...polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat());
    });
    return points.length ? pointBounds(points) : this.containerBounds();
  }
}

interface ItemSample { polygons: Point[][]; bounds: Bounds }

function primitiveFor(state: EditorState, selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): PrimitiveEditor | null {
  if (selection.kind === "container") return state.containerParts[selection.index]?.primitive ?? null;
  if (selection.kind === "exclusion") return state.exclusions[selection.index]?.primitive ?? null;
  return state.items[selection.index]?.parts[partIndex] ?? null;
}

function itemGeometryCenter(state: EditorState, itemIndex: number): Point {
  const shape = toProblem(state).items[itemIndex]?.shape;
  if (!shape) return { x: 0, y: 0 };
  const points = polygons(shape).flat();
  if (!points.length) return { x: 0, y: 0 };
  const bounds = pointBounds(points);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function containerComponentIndices(state: EditorState, startIndex: number): number[] {
  const primitives = state.containerParts.map((entry) => entry.primitive), byId = new Map(primitives.map((part, index) => [part.id, index]));
  const seen = new Set<number>(), queue = [startIndex];
  while (queue.length) {
    const index = queue.shift()!; if (seen.has(index) || !primitives[index]) continue; seen.add(index);
    const target = primitives[index].snap ? byId.get(primitives[index].snap!.targetId) : undefined;
    if (target !== undefined) queue.push(target);
    primitives.forEach((part, candidate) => { if (part.snap?.targetId === primitives[index].id) queue.push(candidate); });
  }
  return [...seen];
}

function primitiveDependsOn(parts: PrimitiveEditor[], startId: string, targetId: string): boolean {
  const byId = new Map(parts.map((part) => [part.id, part])), seen = new Set<string>(); let current = byId.get(startId);
  while (current?.snap && !seen.has(current.id)) {
    if (current.snap.targetId === targetId) return true;
    seen.add(current.id); current = byId.get(current.snap.targetId);
  }
  return false;
}

function containerGeometryCenter(state: EditorState, indices: number[]): Point {
  const problem = toProblem(state);
  const points = indices.flatMap((index) => {
    const part = problem.container.parts[index];
    return part ? polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat() : [];
  });
  if (!points.length) return { x: 0, y: 0 };
  const bounds = pointBounds(points);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function copyPrimitiveGeometry(target: PrimitiveEditor, source: PrimitiveEditor): void {
  Object.assign(target, structuredClone(source));
}

function scalePrimitiveGeometry(part: PrimitiveEditor, factor: number): void {
  if (part.kind === "rectangle") { part.width = round(part.width * factor); part.height = round(part.height * factor); }
  else if (part.kind === "triangle") { part.base = round(part.base * factor); part.height = round(part.height * factor); }
  else if (part.kind === "circle") part.radius = round(part.radius * factor);
  else if (part.kind === "polygon") part.vertices.forEach((point) => { point.x = round(point.x * factor); point.y = round(point.y * factor); });
  else part.knots.forEach((knot) => [knot.point, knot.control_in, knot.control_out].forEach((point) => { point.x = round(point.x * factor); point.y = round(point.y * factor); }));
}

function rotateVector(point: Point, rotation: number): Point {
  const radians = rotation * Math.PI / 180;
  return { x: round(point.x * Math.cos(radians) - point.y * Math.sin(radians)), y: round(point.x * Math.sin(radians) + point.y * Math.cos(radians)) };
}

function selectionFrom(element: SVGElement): CadSelection {
  return { kind: element.dataset.cadKind as CadSelection["kind"], index: Number(element.dataset.cadIndex) } as CadSelection;
}

function parseDefinitionKey(value: string): Exclude<CadSelection, { kind: "placement" }> {
  const [kind, index] = value.split(":");
  return { kind: kind as "container" | "exclusion" | "item", index: Number(index) };
}

function polygons(shape: Shape, rotation = 0, x = 0, y = 0): Point[][] {
  if (shape.kind === "compound") {
    const translations = resolveShapePartTranslations(shape.parts);
    return shape.parts.flatMap((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y)
      .map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y))));
  }
  return [shapePoints(shape).map((point) => transformPoint(point, rotation, x, y))];
}

function inverseTransformPoint(point: Point, rotation: number, x: number, y: number): Point {
  const radians = -rotation * Math.PI / 180;
  const dx = point.x - x, dy = point.y - y;
  return { x: dx * Math.cos(radians) - dy * Math.sin(radians), y: dx * Math.sin(radians) + dy * Math.cos(radians) };
}

function resolveShapePartTranslations(parts: ShapePart[]): Point[] {
  const resolved: Array<Point | undefined> = Array(parts.length);
  const active = new Set<number>();
  const resolve = (index: number): Point => {
    if (resolved[index]) return resolved[index]!;
    const part = parts[index];
    if (!part.snap || !parts[part.snap.target_part] || active.has(index)) return part.translation;
    active.add(index);
    const targetPosition = resolve(part.snap.target_part);
    const own = shapeAnchor(part.shape, part.rotation_deg, part.snap.own_anchor);
    const target = shapeAnchor(parts[part.snap.target_part].shape, parts[part.snap.target_part].rotation_deg, part.snap.target_anchor);
    const position = { x: targetPosition.x + target.x - own.x + part.snap.offset.x, y: targetPosition.y + target.y - own.y + part.snap.offset.y };
    active.delete(index); resolved[index] = position; return position;
  };
  return parts.map((_, index) => resolve(index));
}

function shapeAnchor(shape: Shape, rotation: number, anchor: AnchorName): Point {
  const bounds = pointBounds(polygons(shape).flat());
  const x = anchor.includes("left") ? bounds.minX : anchor.includes("right") ? bounds.maxX : (bounds.minX + bounds.maxX) / 2;
  const y = anchor.includes("bottom") ? bounds.minY : anchor.includes("top") ? bounds.maxY : (bounds.minY + bounds.maxY) / 2;
  return transformPoint({ x, y }, rotation, 0, 0);
}

function pointBounds(points: Point[]): Bounds {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function path(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${round(point.x, 4)},${round(-point.y, 4)}`).join(" ") + " Z";
}

function gridMarkup(view: View): string {
  const desired = view.width / 18;
  const exponent = 10 ** Math.floor(Math.log10(Math.max(desired, 1e-6)));
  const normalized = desired / exponent;
  const step = (normalized < 2 ? 1 : normalized < 5 ? 2 : 5) * exponent;
  const lines: string[] = [];
  for (let x = Math.floor(view.minX / step) * step; x <= view.minX + view.width; x += step) lines.push(`<line x1="${x}" y1="${-view.minY - view.height}" x2="${x}" y2="${-view.minY}"/>`);
  for (let y = Math.floor(view.minY / step) * step; y <= view.minY + view.height; y += step) lines.push(`<line x1="${view.minX}" y1="${-y}" x2="${view.minX + view.width}" y2="${-y}"/>`);
  return lines.join("");
}

function dimensionsFor(bounds: Bounds, scale: number): string {
  const offset = Math.max(scale * 18, .35);
  const top = bounds.maxY + offset, right = bounds.maxX + offset;
  return `<g class="cad-dimensions"><line x1="${bounds.minX}" y1="${-top}" x2="${bounds.maxX}" y2="${-top}"/><text x="${(bounds.minX + bounds.maxX) / 2}" y="${-top - offset * .25}">${format(bounds.width)}</text><line x1="${right}" y1="${-bounds.minY}" x2="${right}" y2="${-bounds.maxY}"/><text transform="translate(${right + offset * .4} ${-(bounds.minY + bounds.maxY) / 2}) rotate(-90)">${format(bounds.height)}</text></g>`;
}

function offsetPolygon(points: Point[], distance: number): Point[] {
  if (points.length < 3 || distance === 0) return points;
  const area = points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
  const direction = area >= 0 ? 1 : -1;
  const lines = points.map((point, index) => {
    const next = points[(index + 1) % points.length], dx = next.x - point.x, dy = next.y - point.y, length = Math.hypot(dx, dy) || 1;
    return { point: { x: point.x + direction * dy / length * distance, y: point.y - direction * dx / length * distance }, direction: { x: dx, y: dy } };
  });
  return points.map((_, index) => lineIntersection(lines[(index + lines.length - 1) % lines.length], lines[index]) ?? lines[index].point);
}

function lineIntersection(a: { point: Point; direction: Point }, b: { point: Point; direction: Point }): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y;
  const amount = (dx * b.direction.y - dy * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
}

function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }
function round(value: number, digits = 3): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]!); }
