import { primitiveAnchor, primitiveShape, resolveEditorTranslations, shapePoints, toProblem, transformPoint } from "./problem";
import { resolveGeometry } from "./geometry-resolver";
import type { AnchorName, DraftingPath, EditorState, PackingProblem, Placement, Point, PrimitiveEditor, ResolvedProblemGeometry, Shape, ShapePart } from "./types";

const ITEM_COLORS = ["#51c6a4", "#f2b65d", "#7ba4f8", "#d98adf", "#ee716f", "#94c973"];
const ANCHORS: AnchorName[] = ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"];
const ROTATION_SNAP_DEGREES = 15;
const ROTATION_CAPTURE_DEGREES = 2.5;

export type CadSelection =
  | { kind: "container"; index: number }
  | { kind: "exclusion"; index: number; partIndex?: number }
  | { kind: "item"; index: number; partIndex?: number }
  | { kind: "guide"; index: number }
  | { kind: "drafting"; index: number }
  | { kind: "trace"; index: number }
  | { kind: "placement"; index: number };

interface Bounds { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
interface View { minX: number; minY: number; width: number; height: number }
interface Drag {
  mode: "pan" | "marquee" | "placement" | "rotate" | "definition" | "definition-rotate" | "definition-scale" | "geometry" | "draft-point" | "snap-offset" | "part-move" | "anchor-snap" | "group-move" | "group-rotate" | "group-scale";
  startClient: Point;
  startWorld: Point;
  originalView?: View;
  placementIndex?: number;
  originalPlacement?: Placement;
  originalPlacements?: Placement[];
  selection?: Exclude<CadSelection, { kind: "placement" }>;
  originalState?: EditorState;
  center?: Point;
  rotation?: number;
  partIndex?: number;
  geometryHandle?: string;
  ownAnchor?: AnchorName;
  currentWorld?: Point;
  additive?: boolean;
  clickSelection?: CadSelection;
  clickPartIndex?: number;
  moved: boolean;
}

export interface CadWorkspaceCallbacks {
  onSelect(selection: CadSelection | null, partIndex?: number, additive?: boolean): void;
  onMarquee(selections: CadSelection[], additive: boolean): void;
  onDefinitionChange(selection: Exclude<CadSelection, { kind: "placement" }>, previous: EditorState): void;
  onPlacementChange(index: number, placement: Placement): void;
  onDraftingPath(points: Point[]): void;
  onConstructionGuide(point: Point, rotation: number): void;
  onPlacementRejected?(index: number): void;
  onPlacementAdjusted?(index: number): void;
}

export class CadWorkspace {
  private state: EditorState;
  private problem: PackingProblem;
  private resolved: ResolvedProblemGeometry;
  private placements: Placement[] = [];
  private selection: CadSelection | null = null;
  private selections: CadSelection[] = [];
  private selectedPartIndex = 0;
  private view: View = { minX: -20, minY: -12, width: 40, height: 24 };
  private drag: Drag | null = null;
  private dimensions = false;
  private clearance = false;
  private fitted = false;
  private respectFixed = true;
  private draftTool: "line" | "polyline" | null = null;
  private draftPoints: Point[] = [];
  private draftHover: Point | null = null;
  private guideTool: number | null = null;
  private guideHover: Point | null = null;
  private readonly sampleOffsets = new Map<string, Point>();

  constructor(
    private readonly svg: SVGSVGElement,
    state: EditorState,
    problem: PackingProblem,
    private readonly callbacks: CadWorkspaceCallbacks,
  ) {
    this.state = state;
    this.problem = problem;
    this.resolved = resolveGeometry(problem);
    this.bind();
    this.fit();
  }

  destroy(): void {
    this.svg.replaceWith(this.svg.cloneNode(false));
  }

  setModel(state: EditorState, problem: PackingProblem, placements: Placement[], refit = false): void {
    this.state = state;
    this.problem = problem;
    this.resolved = resolveGeometry(problem);
    this.placements = placements;
    this.selections = this.selections.filter((entry) => !this.isLocked(entry));
    if (this.selection && this.isLocked(this.selection)) this.selection = null;
    if (refit) this.sampleOffsets.clear();
    if (refit || !this.fitted) this.fit(); else this.render();
  }

  setSelection(selection: CadSelection | null, partIndex = this.selectedPartIndex, selections: CadSelection[] = selection ? [selection] : []): void {
    this.selection = selection && !this.isLocked(selection) ? selection : null;
    this.selections = selections.filter((entry) => !this.isLocked(entry));
    this.selectedPartIndex = partIndex;
    this.render();
  }

  setOverlays(dimensions: boolean, clearance: boolean): void {
    this.dimensions = dimensions;
    this.clearance = clearance;
    this.render();
  }

  setRespectFixed(value: boolean): void { this.respectFixed = value; }

  setDraftTool(tool: "line" | "polyline" | null): void {
    this.draftTool = tool; this.draftPoints = []; this.draftHover = null;
    if (tool) { this.guideTool = null; this.guideHover = null; this.svg.classList.remove("placing-guide"); }
    this.svg.classList.toggle("placing-draft", tool !== null);
    this.render();
  }

  setGuideTool(rotation: number | null): void {
    this.guideTool = rotation; this.guideHover = null;
    if (rotation !== null) { this.draftTool = null; this.draftPoints = []; this.draftHover = null; this.svg.classList.remove("placing-draft"); }
    this.svg.classList.toggle("placing-guide", rotation !== null);
    this.render();
  }

  finishDraftPath(): boolean {
    if (!this.draftTool) return false;
    if (this.draftPoints.length >= 2) this.callbacks.onDraftingPath(this.draftPoints);
    this.setDraftTool(null); return true;
  }

  selectionCenter(selection: CadSelection): Point {
    const bounds = this.selectionBounds(selection);
    return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
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
      const partIndex = selection.kind === "item" || selection.kind === "exclusion" ? selection.partIndex ?? 0 : undefined;
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
      <g class="cad-grid">${gridMarkup(this.view, this.state.drafting.gridStep)}</g>
      ${this.traceImageMarkup()}
      <g class="cad-container"><defs><clipPath id="container-union-clip"><path fill-rule="evenodd" d="${compoundPath(this.resolved.container)}"/></clipPath></defs>
        ${this.problem.container.parts.map((part, index) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path class="cad-part-color container" clip-path="url(#container-union-clip)" style="fill:${containerColor(this.state.containerParts[index]?.primitive)}" d="${path(polygon)}"/>`).join("")).join("")}
        <path data-unified-geometry="container" class="cad-region unified ${this.selections.some((entry) => entry.kind === "container") ? "selected" : ""}" style="fill:transparent" fill-rule="evenodd" d="${compoundPath(this.resolved.container)}"/>
        ${this.problem.container.parts.map((part, index) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path ${this.isLocked({ kind: "container", index }) ? "" : `data-cad-kind="container" data-cad-index="${index}"`} class="cad-source-hit ${this.isLocked({ kind: "container", index }) ? "locked" : this.isSelected({ kind: "container", index }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("")}</g>
      ${this.clearance ? this.containerClearanceMarkup() : ""}
      <g class="cad-exclusions">${this.problem.exclusions.map((entry, index) => {
        const selected = this.isSelected({ kind: "exclusion", index });
        const visible = this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? [];
        const sources = sourcePartPolygons(entry.shape);
        const locked = this.isLocked({ kind: "exclusion", index });
        return `<defs><clipPath id="exclusion-union-clip-${index}"><path fill-rule="evenodd" d="${compoundPath(visible)}"/></clipPath></defs>${sources.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color exclusion" clip-path="url(#exclusion-union-clip-${index})" style="fill:${partColor(this.state.exclusions[index]?.parts[partIndex], "#ee716f")}" d="${path(polygon)}"/>`).join("")).join("")}<path data-unified-geometry="exclusion:${index}" class="cad-exclusion unified ${selected ? "selected" : ""}" style="fill:transparent" fill-rule="evenodd" d="${compoundPath(visible)}"/>${sources.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path ${locked ? "" : `data-cad-kind="exclusion" data-cad-index="${index}" data-cad-part="${partIndex}"`} class="cad-source-hit ${locked ? "locked" : this.isSelected({ kind: "exclusion", index, partIndex }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("")}`;
      }).join("")}</g>
      ${this.clearance ? this.exclusionClearanceMarkup() : ""}
      <g class="cad-placements">${this.placements.map((placement, index) => this.placementMarkup(placement, index)).join("")}</g>
      <g class="cad-library">${samples.map((sample, index) => this.itemSampleMarkup(sample, index)).join("")}</g>
      ${this.dimensions ? this.dimensionMarkup() : ""}
      ${this.draftingMarkup()}
      ${this.traceImageHitMarkup()}
      ${this.selections.length > 1 ? this.multiSelectionMarkup(scale) : this.selection ? this.selectionHandles(this.selection, scale) : ""}
      ${this.guidePreviewMarkup(scale)}
      ${this.draftPreviewMarkup(scale)}
      ${this.marqueeMarkup()}`;
  }

  private isSelected(selection: CadSelection): boolean {
    return this.selections.some((entry) => sameSelection(entry, selection));
  }

  private isLocked(selection: CadSelection): boolean {
    const ref = lockReference(this.state, selection, this.placements);
    return !!ref && this.state.lockedEntities.some((entry) => entry.kind === ref.kind && entry.id === ref.id);
  }

  private traceImageMarkup(): string {
    return this.state.drafting.traceImages.map((trace) => `<g transform="translate(${trace.x} ${-trace.y}) rotate(${-trace.rotation})"><image class="cad-trace-image" href="${escapeHtml(trace.dataUrl)}" x="${-trace.width / 2}" y="${-trace.height / 2}" width="${trace.width}" height="${trace.height}" opacity="${clamp(trace.opacity, 0, 1)}" preserveAspectRatio="none"/></g>`).join("");
  }

  private traceImageHitMarkup(): string {
    return this.state.drafting.traceImages.map((trace, index) => this.isLocked({ kind: "trace", index }) ? "" : `<rect data-cad-kind="trace" data-cad-index="${index}" class="cad-trace-hit ${this.isSelected({ kind: "trace", index }) ? "selected" : ""}" transform="translate(${trace.x} ${-trace.y}) rotate(${-trace.rotation})" x="${-trace.width / 2}" y="${-trace.height / 2}" width="${trace.width}" height="${trace.height}"/>`).join("");
  }

  private draftingMarkup(): string {
    const reach = Math.hypot(this.view.width, this.view.height) * 2;
    const guides = this.state.drafting.guides.map((guide, index) => {
      const vector = rotateVector({ x: reach, y: 0 }, guide.rotation), selected = this.isSelected({ kind: "guide", index });
      const coordinates = `x1="${guide.x - vector.x}" y1="${-(guide.y - vector.y)}" x2="${guide.x + vector.x}" y2="${-(guide.y + vector.y)}"`;
      const hit = this.isLocked({ kind: "guide", index }) ? "" : `<line data-cad-kind="guide" data-cad-index="${index}" class="cad-construction-guide" ${coordinates}/>`;
      return `<line class="cad-guide-visual ${selected ? "selected" : ""}" ${coordinates}/>${hit}`;
    }).join("");
    const shapes = this.state.drafting.shapes.map((shape, index) => {
      const points = draftingWorldPoints(shape), d = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${point.x},${-point.y}`).join(" ") + (shape.closed ? " Z" : "");
      const locked = this.isLocked({ kind: "drafting", index });
      return `<path ${locked ? "" : `data-cad-kind="drafting" data-cad-index="${index}"`} class="cad-drafting-shape ${locked ? "locked" : this.isSelected({ kind: "drafting", index }) ? "selected" : ""}" d="${d}"/>`;
    }).join("");
    return `<g class="cad-construction-guides">${guides}${shapes}</g>`;
  }

  private draftPreviewMarkup(scale: number): string {
    if (!this.draftTool || !this.draftHover) return "";
    const points = [...this.draftPoints, this.draftHover], point = this.draftHover;
    const preview = this.draftPoints.length ? `<polyline class="cad-draft-preview" points="${points.map((entry) => `${entry.x},${-entry.y}`).join(" ")}"/>` : "";
    return `${preview}<g class="cad-draft-cursor"><circle cx="${point.x}" cy="${-point.y}" r="${Math.max(5 * scale, .1)}"/><line x1="${point.x - Math.max(8 * scale, .16)}" y1="${-point.y}" x2="${point.x + Math.max(8 * scale, .16)}" y2="${-point.y}"/><line x1="${point.x}" y1="${-point.y - Math.max(8 * scale, .16)}" x2="${point.x}" y2="${-point.y + Math.max(8 * scale, .16)}"/><text x="${point.x + Math.max(9 * scale, .18)}" y="${-point.y - Math.max(9 * scale, .18)}">${format(point.x)}, ${format(point.y)}</text></g>`;
  }

  private guidePreviewMarkup(scale: number): string {
    if (this.guideTool === null || !this.guideHover) return "";
    const reach = Math.hypot(this.view.width, this.view.height) * 2;
    const vector = rotateVector({ x: reach, y: 0 }, this.guideTool), point = this.guideHover;
    return `<g class="cad-guide-placement-preview"><line x1="${point.x - vector.x}" y1="${-(point.y - vector.y)}" x2="${point.x + vector.x}" y2="${-(point.y + vector.y)}"/><circle cx="${point.x}" cy="${-point.y}" r="${Math.max(5 * scale, .1)}"/><text x="${point.x + Math.max(9 * scale, .18)}" y="${-point.y - Math.max(9 * scale, .18)}">${format(point.x)}, ${format(point.y)}</text></g>`;
  }

  private snapDraftPoint(point: Point, bypass = false): Point {
    if (bypass || !this.state.drafting.snapToGrid) return { x: round(point.x), y: round(point.y) };
    return { x: round(snapUnit(point.x, this.state.drafting.gridStep)), y: round(snapUnit(point.y, this.state.drafting.gridStep)) };
  }

  private pointerDown(event: PointerEvent): void {
    this.svg.focus();
    if (this.guideTool !== null) {
      const point = this.snapDraftPoint(this.eventPoint(event), event.altKey), rotation = this.guideTool;
      this.callbacks.onConstructionGuide(point, rotation); this.setGuideTool(null); return;
    }
    if (this.draftTool) {
      if (event.detail >= 2 && this.draftTool === "polyline") { this.finishDraftPath(); return; }
      const point = this.snapDraftPoint(this.eventPoint(event), event.altKey); this.draftPoints.push(point); this.draftHover = point;
      if (this.draftTool === "line" && this.draftPoints.length === 2) this.finishDraftPath(); else this.render();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const hit = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest<SVGElement>("[data-cad-kind]")).find(Boolean);
      if (hit) {
        const selection = selectionFrom(hit), partIndex = selection.kind === "item" || selection.kind === "exclusion" ? selection.partIndex ?? 0 : undefined;
        const world = this.eventPoint(event);
        this.drag = { mode: "marquee", startClient: { x: event.clientX, y: event.clientY }, startWorld: world, currentWorld: world, additive: true, clickSelection: selection, clickPartIndex: partIndex, moved: false };
        this.svg.setPointerCapture(event.pointerId); return;
      }
    }
    const groupHandle = (event.target as Element).closest<SVGElement>("[data-group-transform]");
    if (groupHandle && this.selections.length > 1) {
      const bounds = this.groupSelectionBounds(); if (!bounds) return;
      const action = groupHandle.dataset.groupTransform as "move" | "rotate" | "scale";
      this.drag = {
        mode: `group-${action}`, startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
        originalState: structuredClone(this.state), originalPlacements: structuredClone(this.placements), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId); return;
    }
    const selectedGeometry = (event.target as Element).closest<SVGElement>("[data-cad-kind]");
    if (selectedGeometry && this.selections.length > 1 && this.isSelected(selectionFrom(selectedGeometry))) {
      const bounds = this.groupSelectionBounds(); if (!bounds) return;
      this.drag = {
        mode: "group-move", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
        originalState: structuredClone(this.state), originalPlacements: structuredClone(this.placements), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId); return;
    }
    const anchorHandle = (event.target as Element).closest<SVGElement>("[data-snap-anchor-source]");
    if (anchorHandle) {
      const definition = parseDefinitionKey(anchorHandle.dataset.snapAnchorSource!);
      const partIndex = Number(anchorHandle.dataset.snapPart ?? 0);
      this.selection = definition; this.selectedPartIndex = partIndex; this.callbacks.onSelect(definition, partIndex);
      this.drag = {
        mode: "anchor-snap", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), currentWorld: this.eventPoint(event),
        selection: definition, partIndex, ownAnchor: anchorHandle.dataset.snapOwnAnchor as AnchorName, originalState: structuredClone(this.state), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId); this.render(); return;
    }
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
      const parsed = parseDefinitionKey(partMove.dataset.partMove!);
      const partIndex = Number(partMove.dataset.partIndex ?? 0);
      const definition = parsed.kind === "item" || parsed.kind === "exclusion" ? { ...parsed, partIndex } : parsed;
      this.selection = definition; this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(definition, partIndex);
      this.drag = {
        mode: "part-move", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, partIndex, originalState: structuredClone(this.state), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId); this.render();
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
      this.svg.setPointerCapture(event.pointerId); this.render();
      return;
    }
    const draftPointHandle = (event.target as Element).closest<SVGElement>("[data-drafting-point]");
    if (draftPointHandle) {
      const index = Number(draftPointHandle.dataset.draftingIndex), pointIndex = Number(draftPointHandle.dataset.draftingPoint);
      const definition: Extract<CadSelection, { kind: "drafting" }> = { kind: "drafting", index };
      this.selection = definition; this.callbacks.onSelect(definition);
      this.drag = {
        mode: "draft-point", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
        selection: definition, partIndex: pointIndex, originalState: structuredClone(this.state), moved: false,
      };
      this.svg.setPointerCapture(event.pointerId); return;
    }
    const scaleHandle = (event.target as Element).closest<SVGElement>("[data-definition-scale]");
    if (scaleHandle) {
      const definition = parseDefinitionKey(scaleHandle.dataset.definitionScale!);
      const center = this.definitionCenter(definition);
      this.selection = definition;
      this.callbacks.onSelect(definition, definition.kind === "item" || definition.kind === "exclusion" ? this.selectedPartIndex : undefined);
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
      const additive = event.ctrlKey || event.metaKey;
      if (additive) {
        const partIndex = selection.kind === "item" || selection.kind === "exclusion" ? selection.partIndex ?? 0 : undefined;
        const world = this.eventPoint(event);
        this.drag = {
          mode: "marquee", startClient: { x: event.clientX, y: event.clientY }, startWorld: world, currentWorld: world,
          additive: true, clickSelection: selection, clickPartIndex: partIndex, moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
        return;
      }
      this.selection = selection;
      const partIndex = selection.kind === "item" || selection.kind === "exclusion" ? selection.partIndex ?? 0 : undefined;
      if (partIndex !== undefined) this.selectedPartIndex = partIndex;
      this.callbacks.onSelect(selection, partIndex);
      if (selection.kind === "placement") {
        const placement = this.placements[selection.index];
        this.drag = { mode: "placement", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), placementIndex: selection.index, originalPlacement: { ...placement }, moved: false };
        this.svg.setPointerCapture(event.pointerId);
      } else if ((selection.kind === "item" || selection.kind === "exclusion") && selection.partIndex !== undefined) {
        this.drag = {
          mode: "part-move", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
          selection, partIndex: selection.partIndex, originalState: structuredClone(this.state), moved: false,
        };
        this.svg.setPointerCapture(event.pointerId);
        this.render();
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
    const world = this.eventPoint(event);
    if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
      this.drag = { mode: "marquee", startClient: { x: event.clientX, y: event.clientY }, startWorld: world, currentWorld: world, additive: false, moved: false };
    } else {
      this.callbacks.onSelect(null);
      this.drag = { mode: "pan", startClient: { x: event.clientX, y: event.clientY }, startWorld: world, originalView: { ...this.view }, moved: false };
    }
    this.svg.setPointerCapture(event.pointerId);
    this.render();
  }

  private pointerMove(event: PointerEvent): void {
    if (this.guideTool !== null && !this.drag) { this.guideHover = this.snapDraftPoint(this.eventPoint(event), event.altKey); this.render(); return; }
    if (this.draftTool && !this.drag) { this.draftHover = this.snapDraftPoint(this.eventPoint(event), event.altKey); this.render(); return; }
    if (!this.drag) return;
    if (this.drag.mode === "anchor-snap") {
      this.drag.currentWorld = this.eventPoint(event); this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "marquee") {
      this.drag.currentWorld = this.eventPoint(event);
      this.drag.moved = Math.hypot(event.clientX - this.drag.startClient.x, event.clientY - this.drag.startClient.y) > 3;
      this.render();
      return;
    }
    if (this.drag.mode === "pan") {
      const distance = Math.hypot(event.clientX - this.drag.startClient.x, event.clientY - this.drag.startClient.y);
      if (distance <= 3) return;
      const pixelsToWorld = this.drag.originalView!.width / Math.max(this.svg.clientWidth, 1);
      this.view.minX = this.drag.originalView!.minX - (event.clientX - this.drag.startClient.x) * pixelsToWorld;
      this.view.minY = this.drag.originalView!.minY + (event.clientY - this.drag.startClient.y) * pixelsToWorld;
      this.drag.moved = true;
      this.render();
      return;
    }
    if (this.drag.mode === "draft-point") {
      const selection = this.drag.selection;
      if (selection?.kind !== "drafting" || this.drag.partIndex === undefined) return;
      const shape = this.state.drafting.shapes[selection.index], source = this.drag.originalState?.drafting.shapes[selection.index];
      if (!shape || !source || !shape.points[this.drag.partIndex]) return;
      const world = this.snapDraftPoint(this.eventPoint(event), event.altKey);
      const local = inverseTransformPoint(world, source.rotation, source.x, source.y);
      shape.points[this.drag.partIndex] = { x: round(local.x), y: round(local.y) };
      this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "group-move" || this.drag.mode === "group-rotate" || this.drag.mode === "group-scale") {
      const current = this.eventPoint(event), center = this.drag.center!;
      if (this.drag.mode === "group-move") this.transformSelectionGroup(this.drag.originalState!, this.drag.originalPlacements!, "move", current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y);
      else if (this.drag.mode === "group-rotate") {
        const start = Math.atan2(this.drag.startWorld.y - center.y, this.drag.startWorld.x - center.x), angle = Math.atan2(current.y - center.y, current.x - center.x);
        const rawDelta = (angle - start) * 180 / Math.PI;
        this.transformSelectionGroup(this.drag.originalState!, this.drag.originalPlacements!, "rotate", event.altKey ? rawDelta : snapAngle(rawDelta), 0);
      } else {
        const start = Math.max(Math.hypot(this.drag.startWorld.x - center.x, this.drag.startWorld.y - center.y), 1e-6);
        this.transformSelectionGroup(this.drag.originalState!, this.drag.originalPlacements!, "scale", clamp(Math.hypot(current.x - center.x, current.y - center.y) / start, .02, 50), 0);
      }
      this.problem = toProblem(this.state); this.resolved = resolveGeometry(this.problem); this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "definition" || this.drag.mode === "definition-rotate" || this.drag.mode === "definition-scale" || this.drag.mode === "geometry" || this.drag.mode === "snap-offset" || this.drag.mode === "part-move") {
      const selection = this.drag.selection!;
      const current = this.eventPoint(event);
      if (this.drag.mode === "definition") {
        const delta = event.altKey ? { x: current.x - this.drag.startWorld.x, y: current.y - this.drag.startWorld.y }
          : this.snappedMoveDelta(selection, this.drag.originalState!, current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y, this.drag.partIndex);
        this.moveDefinition(selection, this.drag.originalState!, delta.x, delta.y, event.altKey);
      } else if (this.drag.mode === "definition-rotate") {
        const center = this.drag.center!;
        const start = Math.atan2(this.drag.startWorld.y - center.y, this.drag.startWorld.x - center.x);
        const angle = Math.atan2(current.y - center.y, current.x - center.x);
        const rawDelta = (angle - start) * 180 / Math.PI;
        this.rotateDefinition(selection, this.drag.originalState!, event.altKey ? rawDelta : this.snappedRotationDelta(selection, this.drag.originalState!, rawDelta));
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
        const selectedParts = this.selections.filter((entry): entry is Extract<CadSelection, { kind: "container" | "item" | "exclusion" }> => entry.kind === "container" || entry.kind === "item" || entry.kind === "exclusion");
        const targets: Array<Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>> = selectedParts.length > 1 ? selectedParts : [selection as Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>];
        const delta = { x: current.x - this.drag.startWorld.x, y: current.y - this.drag.startWorld.y };
        targets.forEach((entry) => this.movePart(entry, this.drag!.originalState!, entry.kind === "container" ? entry.index : entry.partIndex ?? this.drag!.partIndex!, delta.x, delta.y));
      } else {
        this.editDefinitionGeometry(selection, this.drag.originalState!, this.drag.partIndex!, this.drag.geometryHandle!, current, this.drag.center!, this.drag.rotation!, event.altKey, event.shiftKey);
      }
      this.problem = toProblem(this.state);
      this.resolved = resolveGeometry(this.problem);
      this.drag.moved = true;
      this.render();
      return;
    }
    const index = this.drag.placementIndex!;
    const placement = this.placements[index];
    const original = this.drag.originalPlacement!;
    const current = this.eventPoint(event);
    if (this.drag.mode === "placement") {
      const rawX = original.x + current.x - this.drag.startWorld.x, rawY = original.y + current.y - this.drag.startWorld.y;
      placement.x = round(this.state.drafting.snapToGrid ? snapUnit(rawX, this.state.drafting.gridStep) : rawX);
      placement.y = round(this.state.drafting.snapToGrid ? snapUnit(rawY, this.state.drafting.gridStep) : rawY);
    } else {
      const start = Math.atan2(this.drag.startWorld.y - original.y, this.drag.startWorld.x - original.x);
      const angle = Math.atan2(current.y - original.y, current.x - original.x);
      const rawRotation = original.rotation_deg + (angle - start) * 180 / Math.PI;
      placement.rotation_deg = round(event.altKey ? rawRotation : snapAngle(rawRotation), 1);
    }
    this.drag.moved = true;
    this.render();
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    if (drag.mode === "marquee") {
      if (drag.moved && drag.currentWorld) this.callbacks.onMarquee(this.selectionsInBox(drag.startWorld, drag.currentWorld), !!drag.additive);
      else if (drag.clickSelection) this.callbacks.onSelect(drag.clickSelection, drag.clickPartIndex, true);
      else this.callbacks.onSelect(null);
      this.render();
      return;
    }
    if (drag.mode === "pan" && !drag.moved) {
      this.callbacks.onSelect(null);
      this.render();
      return;
    }
    if (drag.moved && drag.mode === "anchor-snap" && drag.selection && drag.partIndex !== undefined && drag.ownAnchor && drag.currentWorld) {
      this.completeAnchorSnap(drag.selection, drag.partIndex, drag.ownAnchor, drag.currentWorld);
    }
    if (drag.moved && drag.mode === "part-move" && drag.selection && drag.partIndex !== undefined && !event.altKey) {
      const anchored = this.snapMovedPart(drag.selection, drag.partIndex);
      if (!anchored && drag.originalState) {
        const current = resolvedPrimitivePosition(this.state, drag.selection, drag.partIndex);
        const original = resolvedPrimitivePosition(drag.originalState, drag.selection, drag.partIndex);
        const delta = this.snappedMoveDelta(drag.selection, drag.originalState, current.x - original.x, current.y - original.y, drag.partIndex);
        const selectedParts = this.selections.filter((entry): entry is Extract<CadSelection, { kind: "container" | "item" | "exclusion" }> => entry.kind === "container" || entry.kind === "item" || entry.kind === "exclusion");
        const targets: Array<Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>> = selectedParts.length > 1 ? selectedParts : [drag.selection as Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>];
        targets.forEach((entry) => this.movePart(entry, drag.originalState!, entry.kind === "container" ? entry.index : entry.partIndex ?? drag.partIndex!, delta.x, delta.y));
        this.problem = toProblem(this.state); this.resolved = resolveGeometry(this.problem);
      }
    }
    if (drag.moved && drag.placementIndex !== undefined) {
      if (this.respectFixed && drag.mode === "placement" && !this.placementSatisfiesConstraints(drag.placementIndex)) {
        const adjusted = this.closestFeasiblePlacement(drag.placementIndex, drag.originalPlacement!);
        if (adjusted) { Object.assign(this.placements[drag.placementIndex], adjusted); this.callbacks.onPlacementChange(drag.placementIndex, this.placements[drag.placementIndex]); this.callbacks.onPlacementAdjusted?.(drag.placementIndex); }
        else { Object.assign(this.placements[drag.placementIndex], drag.originalPlacement); this.callbacks.onPlacementRejected?.(drag.placementIndex); }
      } else this.callbacks.onPlacementChange(drag.placementIndex, this.placements[drag.placementIndex]);
    }
    if (drag.moved && drag.selection && drag.originalState) this.callbacks.onDefinitionChange(drag.selection, drag.originalState);
    if (drag.moved && (drag.mode === "group-move" || drag.mode === "group-rotate" || drag.mode === "group-scale")) {
      const definition = this.selections.find((entry): entry is Exclude<CadSelection, { kind: "placement" }> => entry.kind !== "placement");
      if (definition && drag.originalState) this.callbacks.onDefinitionChange(definition, drag.originalState);
      this.selections.forEach((entry) => { if (entry.kind === "placement" && this.placements[entry.index]) this.callbacks.onPlacementChange(entry.index, this.placements[entry.index]); });
    }
    this.render();
  }

  private eventPoint(event: MouseEvent | PointerEvent | WheelEvent): Point {
    const point = this.svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(this.svg.getScreenCTM()!.inverse());
    return { x: local.x, y: -local.y };
  }

  private marqueeMarkup(): string {
    if (this.drag?.mode !== "marquee" || !this.drag.moved || !this.drag.currentWorld) return "";
    const minX = Math.min(this.drag.startWorld.x, this.drag.currentWorld.x);
    const maxX = Math.max(this.drag.startWorld.x, this.drag.currentWorld.x);
    const minY = Math.min(this.drag.startWorld.y, this.drag.currentWorld.y);
    const maxY = Math.max(this.drag.startWorld.y, this.drag.currentWorld.y);
    return `<rect class="cad-marquee" x="${minX}" y="${-maxY}" width="${maxX - minX}" height="${maxY - minY}"/>`;
  }

  private selectionsInBox(a: Point, b: Point): CadSelection[] {
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const candidates: CadSelection[] = [
      ...this.state.containerParts.map((_, index) => ({ kind: "container", index }) as CadSelection),
      ...this.state.exclusions.map((_, index) => ({ kind: "exclusion", index }) as CadSelection),
      ...this.state.items.map((_, index) => ({ kind: "item", index }) as CadSelection),
      ...this.state.drafting.guides.map((_, index) => ({ kind: "guide", index }) as CadSelection),
      ...this.state.drafting.shapes.map((_, index) => ({ kind: "drafting", index }) as CadSelection),
      ...this.state.drafting.traceImages.map((_, index) => ({ kind: "trace", index }) as CadSelection),
      ...this.placements.map((_, index) => ({ kind: "placement", index }) as CadSelection),
    ].filter((entry) => !this.isLocked(entry));
    const selected = candidates.filter((selection) => {
      const bounds = this.selectionBounds(selection);
      if (!bounds) return false;
      return bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= minY && bounds.minY <= maxY;
    });
    const definitions = selected.filter((entry) => entry.kind === "item" || entry.kind === "exclusion");
    if (definitions.length === 1) {
      const owner = definitions[0] as Extract<CadSelection, { kind: "item" | "exclusion" }>;
      const count = owner.kind === "item" ? this.state.items[owner.index]?.parts.length ?? 0 : this.state.exclusions[owner.index]?.parts.length ?? 0;
      const parts = Array.from({ length: count }, (_, partIndex) => ({ ...owner, partIndex })).filter((entry) => {
        const bounds = this.selectionBounds(entry); return !!bounds && bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= minY && bounds.minY <= maxY;
      });
      if (parts.length > 1) return [...selected.filter((entry) => !sameSelection(entry, owner)), ...parts];
    }
    return selected;
  }

  private placementMarkup(placement: Placement, index: number): string {
    const itemIndex = this.problem.items.findIndex((entry) => entry.id === placement.item_id);
    const item = this.problem.items[itemIndex];
    if (!item) return "";
    const color = ITEM_COLORS[Math.max(itemIndex, 0) % ITEM_COLORS.length];
    const selected = this.isSelected({ kind: "placement", index });
    const locked = this.isLocked({ kind: "placement", index });
    const local = this.resolved.items.find((geometry) => geometry.id === item.id)?.polygons ?? [];
    const placed = transformPolygons(local, placement.rotation_deg, placement.x, placement.y);
    const sourceParts = sourcePartPolygons(item.shape).map((partPolygons) => transformPolygons(partPolygons, placement.rotation_deg, placement.x, placement.y));
    const colored = sourceParts.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color item" style="fill:${partColor(this.state.items[itemIndex]?.parts[partIndex], color)}" d="${path(polygon)}"/>`).join("")).join("");
    const paths = `${colored}<path ${locked ? "" : `data-cad-kind="placement" data-cad-index="${index}"`} class="cad-placement unified ${locked ? "locked" : selected ? "selected" : ""} ${placement.fixed ? "fixed" : ""}" fill-rule="evenodd" style="--item-color:${color};fill:transparent" d="${compoundPath(placed)}"/>${this.clearance && this.problem.clearance.item_to_item > 0 ? placed.map((polygon) => `<path class="cad-clearance item" d="${path(offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * this.problem.clearance.item_to_item / 2))}"/>`).join("") : ""}`;
    const fixedBadge = placement.fixed ? `<g class="cad-fixed-badge" aria-label="Fixed placement"><circle cx="${placement.x}" cy="${-placement.y}" r=".32"/><text x="${placement.x}" y="${-placement.y + .12}" text-anchor="middle">F</text></g>` : "";
    return `<g aria-label="${escapeHtml(placement.item_id)} placement ${index + 1}">${paths}${fixedBadge}</g>`;
  }

  private placementSatisfiesConstraints(index: number): boolean {
    const placement = this.placements[index], item = placement && this.problem.items.find((entry) => entry.id === placement.item_id);
    const local = item && this.resolved.items.find((entry) => entry.id === item.id)?.polygons;
    if (!placement || !local) return false;
    const moved = transformPolygons(local, placement.rotation_deg, placement.x, placement.y);
    const boundaryGap = this.problem.clearance.item_to_boundary;
    if (moved.some((polygon) => polygon.some((point) => !pointInCompound(point, this.resolved.container)) || compoundEdgeDistance([polygon], this.resolved.container) < boundaryGap - 1e-8)) return false;
    for (const exclusion of this.resolved.exclusions) {
      const required = Math.max(this.problem.clearance.item_to_exclusion, this.problem.exclusions.find((entry) => entry.id === exclusion.id)?.clearance ?? 0);
      if (compoundsOverlap(moved, exclusion.polygons) || compoundDistance(moved, exclusion.polygons) < required - 1e-8) return false;
    }
    for (let otherIndex = 0; otherIndex < this.placements.length; otherIndex++) {
      if (otherIndex === index) continue;
      const other = this.placements[otherIndex], otherItem = this.problem.items.find((entry) => entry.id === other.item_id);
      const otherLocal = otherItem && this.resolved.items.find((entry) => entry.id === otherItem.id)?.polygons;
      if (!otherLocal) continue;
      const placed = transformPolygons(otherLocal, other.rotation_deg, other.x, other.y);
      if (compoundsOverlap(moved, placed) || compoundDistance(moved, placed) < this.problem.clearance.item_to_item - 1e-8) return false;
    }
    return true;
  }

  private closestFeasiblePlacement(index: number, original: Placement): Placement | null {
    const placement = this.placements[index], intended = { ...placement };
    const item = this.problem.items.find((entry) => entry.id === placement.item_id), local = item && this.resolved.items.find((entry) => entry.id === item.id)?.polygons;
    const bounds = local?.flat().length ? pointBounds(local.flat()) : null;
    const step = Math.max(.08, Math.min(bounds?.width ?? 1, bounds?.height ?? 1) / 10, this.problem.clearance.item_to_item / 2);
    const maxRadius = Math.hypot(this.view.width, this.view.height), radialStep = Math.max(step, maxRadius / 80);
    for (let radius = radialStep; radius <= maxRadius; radius += radialStep) {
      const samples = 48;
      for (let sample = 0; sample < samples; sample++) {
        const angle = Math.PI * 2 * sample / samples;
        placement.x = round(intended.x + Math.cos(angle) * radius); placement.y = round(intended.y + Math.sin(angle) * radius);
        if (this.placementSatisfiesConstraints(index)) return { ...placement };
      }
    }
    let low = 0, high = 1, best: Placement | null = null;
    for (let iteration = 0; iteration < 24; iteration++) {
      const ratio = (low + high) / 2;
      placement.x = round(original.x + (intended.x - original.x) * ratio); placement.y = round(original.y + (intended.y - original.y) * ratio);
      if (this.placementSatisfiesConstraints(index)) { best = { ...placement }; low = ratio; } else high = ratio;
    }
    return best;
  }

  private itemSampleMarkup(sample: ItemSample, index: number): string {
    const color = ITEM_COLORS[index % ITEM_COLORS.length];
    const selected = this.isSelected({ kind: "item", index });
    const locked = this.isLocked({ kind: "item", index });
    const padding = Math.max(sample.bounds.width, sample.bounds.height) * .2 + .35;
    return `${sample.sourcePolygons.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color item" style="fill:${partColor(this.state.items[index]?.parts[partIndex], color)}" d="${path(polygon)}"/>`).join("")).join("")}<path data-unified-geometry="item:${index}" class="cad-item-sample unified ${selected ? "selected" : ""}" fill-rule="evenodd" style="--item-color:${color};fill:transparent" d="${compoundPath(sample.polygons)}"/>${sample.sourcePolygons.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path ${locked ? "" : `data-cad-kind="item" data-cad-index="${index}" data-cad-part="${partIndex}"`} class="cad-source-hit ${locked ? "locked" : this.isSelected({ kind: "item", index, partIndex }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("")}${this.clearance && this.problem.clearance.item_to_item > 0 ? sample.polygons.map((polygon) => `<path class="cad-clearance item" d="${path(offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * this.problem.clearance.item_to_item / 2))}"/>`).join("") : ""}
      <text class="cad-label" x="${sample.bounds.minX}" y="${-sample.bounds.maxY - padding}">${escapeHtml(this.problem.items[index].id)} · ${this.problem.items[index].quantity} requested</text>`;
  }

  private selectionHandles(selection: CadSelection, scale: number): string {
    if (this.isLocked(selection)) return "";
    const bounds = this.selectionBounds(selection);
    if (!bounds) return "";
    const offset = Math.max(24 * scale, .5);
    const guide = selection.kind === "guide" ? this.state.drafting.guides[selection.index] : null;
    const top = guide ? { x: guide.x, y: guide.y } : { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY };
    const guideOffset = guide ? rotateVector({ x: 0, y: offset }, guide.rotation) : null;
    const handle = guideOffset ? { x: top.x + guideOffset.x, y: top.y + guideOffset.y } : { x: top.x, y: top.y + offset };
    const attribute = selection.kind === "placement"
      ? `data-placement-rotate="${selection.index}"`
      : `data-definition-rotate="${selection.kind}:${selection.index}"`;
    const isPrimitive = selection.kind === "container" || selection.kind === "item" || selection.kind === "exclusion";
    const geometry = isPrimitive ? this.geometryHandles(selection, scale) : selection.kind === "drafting" ? this.draftingPointHandles(selection, scale) : "";
    const snap = isPrimitive ? this.snapMarkup(selection, scale) : "";
    const resize = selection.kind === "placement" || selection.kind === "guide" ? "" : `<circle class="cad-global-scale-handle" data-definition-scale="${selection.kind}:${selection.index}" cx="${bounds.maxX}" cy="${-bounds.minY}" r="${Math.max(4.5 * scale, .09)}"/>`;
    const anchors = isPrimitive ? this.anchorHandlesMarkup(selection, scale) : "";
    return `<g class="cad-selection-handles">${geometry}${anchors}${snap}${resize}<line x1="${top.x}" y1="${-top.y}" x2="${handle.x}" y2="${-handle.y}"/><circle class="cad-rotate-handle" ${attribute} cx="${handle.x}" cy="${-handle.y}" r="${Math.max(5 * scale, .1)}"/></g>`;
  }

  private draftingPointHandles(selection: Extract<CadSelection, { kind: "drafting" }>, scale: number): string {
    const shape = this.state.drafting.shapes[selection.index]; if (!shape) return "";
    return draftingWorldPoints(shape).map((point, pointIndex) => `<circle class="cad-drafting-point-handle" data-drafting-index="${selection.index}" data-drafting-point="${pointIndex}" cx="${point.x}" cy="${-point.y}" r="${Math.max(4.2 * scale, .085)}"/>`).join("");
  }

  private multiSelectionMarkup(scale: number): string {
    const group = this.groupSelectionBounds(); if (!group) return "";
    const inset = Math.max(5 * scale, .1), box = { minX: group.minX - inset, minY: group.minY - inset, maxX: group.maxX + inset, maxY: group.maxY + inset };
    const top = { x: (box.minX + box.maxX) / 2, y: box.maxY }, rotate = { x: top.x, y: top.y + Math.max(24 * scale, .5) }, radius = Math.max(5 * scale, .1);
    return `<g class="cad-group-selection" aria-label="${this.selections.length} selected"><rect data-group-transform="move" x="${box.minX}" y="${-box.maxY}" width="${box.maxX - box.minX}" height="${box.maxY - box.minY}"/><text x="${box.minX}" y="${-box.maxY - Math.max(8 * scale, .18)}" style="font-size:${Math.max(10 * scale, .18)}px">${this.selections.length} selected</text><line x1="${top.x}" y1="${-top.y}" x2="${rotate.x}" y2="${-rotate.y}"/><circle class="cad-group-rotate" data-group-transform="rotate" cx="${rotate.x}" cy="${-rotate.y}" r="${radius}"/><circle class="cad-group-scale" data-group-transform="scale" cx="${box.maxX}" cy="${-box.minY}" r="${Math.max(4.5 * scale, .09)}"/></g>`;
  }

  private groupSelectionBounds(): Bounds | null {
    const bounds = this.selections.map((selection) => this.selectionBounds(selection)).filter((value): value is Bounds => value !== null); if (!bounds.length) return null;
    const minX = Math.min(...bounds.map((value) => value.minX)), minY = Math.min(...bounds.map((value) => value.minY)), maxX = Math.max(...bounds.map((value) => value.maxX)), maxY = Math.max(...bounds.map((value) => value.maxY));
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  private snapMarkup(selection: Exclude<CadSelection, { kind: "placement" }>, scale: number): string {
    if (this.drag?.mode !== "part-move" || !this.drag.selection || !sameSelection(this.drag.selection, selection)) return "";
    const parts = definitionParts(this.state, selection);
    const partIndex = selection.kind === "container" ? selection.index : this.selectedPartIndex;
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
    const handleOffset = Math.max(11 * scale, .2);
    const ownHandle = { x: own.x + handleOffset, y: own.y + handleOffset };
    return `<g class="cad-snap-constraint"><line x1="${targetCenter.x}" y1="${-targetCenter.y}" x2="${ownCenter.x}" y2="${-ownCenter.y}"/><line class="cad-snap-offset" x1="${destination.x}" y1="${-destination.y}" x2="${own.x}" y2="${-own.y}"/><line x1="${own.x}" y1="${-own.y}" x2="${ownHandle.x}" y2="${-ownHandle.y}"/><circle cx="${destination.x}" cy="${-destination.y}" r="${radius}"/><circle class="own" data-snap-offset-handle="${selection.kind}:${selection.index}" data-snap-part="${partIndex}" cx="${ownHandle.x}" cy="${-ownHandle.y}" r="${radius}"/></g>`;
  }

  private anchorHandlesMarkup(selection: Exclude<CadSelection, { kind: "placement" }>, scale: number): string {
    if (this.drag?.mode !== "part-move" || !this.drag.selection || !sameSelection(this.drag.selection, selection)) return "";
    const parts = definitionParts(this.state, selection), partIndex = selection.kind === "container" ? selection.index : this.selectedPartIndex;
    const part = parts?.[partIndex]; if (!parts || !part) return "";
    const positions = resolveEditorTranslations(parts), displayOffset = this.definitionDisplayOffset(selection);
    const pointFor = (value: PrimitiveEditor, anchor: AnchorName) => {
      const position = positions.get(value.id) ?? { x: value.x, y: value.y }, point = primitiveAnchor(value, anchor, position);
      return { x: point.x + displayOffset.x, y: point.y + displayOffset.y };
    };
    const partCenter = pointFor(part, "center"), handleGap = Math.max(8 * scale, .16);
    const ownHandlePoint = (anchor: AnchorName) => {
      const point = pointFor(part, anchor), dx = point.x - partCenter.x, dy = point.y - partCenter.y, length = Math.hypot(dx, dy);
      const direction = length > 1e-8 ? { x: dx / length, y: dy / length } : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
      return { x: point.x + direction.x * handleGap, y: point.y + direction.y * handleGap };
    };
    const targetRadius = Math.max(2.6 * scale, .05), ownRadius = Math.max(3.5 * scale, .07);
    const targets = parts.flatMap((target) => {
      if (target.id === part.id || primitiveDependsOn(parts, target.id, part.id)) return [];
      return ANCHORS.map((anchor) => {
        const point = pointFor(target, anchor), active = part.snap?.targetId === target.id && part.snap.targetAnchor === anchor;
        return `<circle class="cad-snap-anchor target ${active ? "active" : ""}" data-snap-target-id="${escapeHtml(target.id)}" data-snap-target-anchor="${anchor}" cx="${point.x}" cy="${-point.y}" r="${targetRadius}"/>`;
      });
    }).join("");
    const own = ANCHORS.map((anchor) => {
      const point = pointFor(part, anchor), handle = ownHandlePoint(anchor), active = part.snap?.ownAnchor === anchor;
      return `<line class="cad-anchor-guide" x1="${point.x}" y1="${-point.y}" x2="${handle.x}" y2="${-handle.y}"/><circle class="cad-snap-anchor own ${active ? "active" : ""}" data-snap-anchor-source="${selection.kind}:${selection.index}" data-snap-part="${partIndex}" data-snap-own-anchor="${anchor}" cx="${handle.x}" cy="${-handle.y}" r="${ownRadius}"/>`;
    }).join("");
    return `<g class="cad-anchor-points">${targets}${own}</g>`;
  }

  private definitionDisplayOffset(selection: Exclude<CadSelection, { kind: "placement" }>): Point {
    if (selection.kind !== "item") return { x: 0, y: 0 };
    this.itemSamples();
    return this.sampleOffsets.get(this.state.items[selection.index]?.id ?? "") ?? { x: 0, y: 0 };
  }

  private completeAnchorSnap(
    selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number, ownAnchor: AnchorName, dropPoint: Point,
  ): void {
    const parts = definitionParts(this.state, selection), part = parts?.[partIndex]; if (!parts || !part) return;
    const positions = resolveEditorTranslations(parts), displayOffset = this.definitionDisplayOffset(selection);
    let best: { target: PrimitiveEditor; anchor: AnchorName; distance: number } | null = null;
    parts.forEach((target) => {
      if (target.id === part.id || primitiveDependsOn(parts, target.id, part.id)) return;
      const position = positions.get(target.id) ?? { x: target.x, y: target.y };
      ANCHORS.forEach((anchor) => {
        const raw = primitiveAnchor(target, anchor, position), point = { x: raw.x + displayOffset.x, y: raw.y + displayOffset.y };
        const distance = Math.hypot(point.x - dropPoint.x, point.y - dropPoint.y);
        if (!best || distance < best.distance) best = { target, anchor, distance };
      });
    });
    const candidate = best as { target: PrimitiveEditor; anchor: AnchorName; distance: number } | null;
    const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 32;
    if (!candidate || candidate.distance > threshold) return;
    part.snap = { targetId: candidate.target.id, ownAnchor, targetAnchor: candidate.anchor, offset: { x: 0, y: 0 } };
    this.problem = toProblem(this.state); this.resolved = resolveGeometry(this.problem); this.render();
  }

  private geometryHandles(selection: Exclude<CadSelection, { kind: "placement" }>, scale: number): string {
    const partIndex = selection.kind === "container" ? selection.index : this.selectedPartIndex;
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
      handles.push({ key: "base:left", point: { x: -primitive.base / 2, y: -primitive.height / 2 } }, { key: "base:right", point: { x: primitive.base / 2, y: -primitive.height / 2 } }, { key: "height:top", point: { x: 0, y: primitive.height / 2 } });
    } else if (primitive.kind === "circle") {
      handles.push({ key: "radius:right", point: { x: primitive.radius, y: 0 } }, { key: "radius:left", point: { x: -primitive.radius, y: 0 } }, { key: "radius:top", point: { x: 0, y: primitive.radius } }, { key: "radius:bottom", point: { x: 0, y: -primitive.radius } });
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
      const primitive = this.state.exclusions[selection.index]?.parts[partIndex];
      const shape = this.problem.exclusions[selection.index]?.shape;
      if (!primitive || shape?.kind !== "compound" || !shape.parts[partIndex]) return null;
      const translation = resolveShapePartTranslations(shape.parts)[partIndex];
      return { primitive, center: translation, rotation: shape.parts[partIndex].rotation_deg };
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
    handle: string, world: Point, center: Point, rotation: number, bypassSnapping = false, anchoredResize = false,
  ): void {
    const target = primitiveFor(this.state, selection, partIndex);
    const source = primitiveFor(original, selection, partIndex);
    if (!target || !source || target.kind !== source.kind) return;
    const local = inverseTransformPoint(world, rotation, center.x, center.y);
    if (anchoredResize && this.resizeFromOppositeHandle(target, source, handle, local, rotation, bypassSnapping)) return;
    if (target.kind === "rectangle") {
      const anchor = handle.startsWith("resize:") ? handle.slice(7) : handle;
      if (anchor.includes("left") || anchor.includes("right") || anchor === "width") target.width = this.snapLength(Math.max(.05, Math.abs(local.x) * 2), target, false, bypassSnapping);
      if (anchor.includes("top") || anchor.includes("bottom") || anchor === "height") target.height = this.snapLength(Math.max(.05, Math.abs(local.y) * 2), target, false, bypassSnapping);
    } else if (target.kind === "triangle") {
      if (handle.startsWith("base:")) target.base = this.snapLength(Math.max(.05, Math.abs(local.x) * 2), target, false, bypassSnapping);
      if (handle.startsWith("height:")) target.height = this.snapLength(Math.max(.05, Math.abs(local.y) * 2), target, false, bypassSnapping);
    } else if (target.kind === "circle") {
      if (handle.startsWith("radius:")) target.radius = this.snapLength(Math.max(.025, Math.hypot(local.x, local.y)), target, true, bypassSnapping);
    } else if (target.kind === "polygon" && handle.startsWith("vertex:")) {
      const index = Number(handle.split(":")[1]);
      const snappedWorld = this.snapDraftPoint(world, bypassSnapping), snappedLocal = inverseTransformPoint(snappedWorld, rotation, center.x, center.y);
      if (target.vertices[index]) target.vertices[index] = { x: round(snappedLocal.x), y: round(snappedLocal.y) };
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

  private resizeFromOppositeHandle(
    target: PrimitiveEditor, source: PrimitiveEditor, handle: string, local: Point, rotation: number, bypassSnapping: boolean,
  ): boolean {
    let centerDelta: Point = { x: 0, y: 0 };
    if (target.kind === "rectangle" && source.kind === "rectangle") {
      const anchor = handle.startsWith("resize:") ? handle.slice(7) : handle;
      if (anchor.includes("left")) {
        const fixed = source.width / 2, width = this.snapLength(Math.max(.05, fixed - Math.min(local.x, fixed - .05)), target, false, bypassSnapping);
        target.width = width; centerDelta.x = (source.width - width) / 2;
      } else if (anchor.includes("right")) {
        const fixed = -source.width / 2, width = this.snapLength(Math.max(.05, Math.max(local.x, fixed + .05) - fixed), target, false, bypassSnapping);
        target.width = width; centerDelta.x = (width - source.width) / 2;
      }
      if (anchor.includes("bottom")) {
        const fixed = source.height / 2, height = this.snapLength(Math.max(.05, fixed - Math.min(local.y, fixed - .05)), target, false, bypassSnapping);
        target.height = height; centerDelta.y = (source.height - height) / 2;
      } else if (anchor.includes("top")) {
        const fixed = -source.height / 2, height = this.snapLength(Math.max(.05, Math.max(local.y, fixed + .05) - fixed), target, false, bypassSnapping);
        target.height = height; centerDelta.y = (height - source.height) / 2;
      }
    } else if (target.kind === "triangle" && source.kind === "triangle") {
      if (handle === "base:left") {
        const fixed = source.base / 2, base = this.snapLength(Math.max(.05, fixed - Math.min(local.x, fixed - .05)), target, false, bypassSnapping);
        target.base = base; centerDelta.x = (source.base - base) / 2;
      } else if (handle === "base:right") {
        const fixed = -source.base / 2, base = this.snapLength(Math.max(.05, Math.max(local.x, fixed + .05) - fixed), target, false, bypassSnapping);
        target.base = base; centerDelta.x = (base - source.base) / 2;
      } else if (handle === "height:top") {
        const fixed = -source.height / 2, height = this.snapLength(Math.max(.05, Math.max(local.y, fixed + .05) - fixed), target, false, bypassSnapping);
        target.height = height; centerDelta.y = (height - source.height) / 2;
      } else return false;
    } else if (target.kind === "circle" && source.kind === "circle" && handle.startsWith("radius:")) {
      if (handle === "radius:left") {
        const fixed = source.radius, radius = this.snapLength(Math.max(.025, (fixed - Math.min(local.x, fixed - .05)) / 2), target, true, bypassSnapping);
        target.radius = radius; centerDelta.x = source.radius - radius;
      } else if (handle === "radius:right") {
        const fixed = -source.radius, radius = this.snapLength(Math.max(.025, (Math.max(local.x, fixed + .05) - fixed) / 2), target, true, bypassSnapping);
        target.radius = radius; centerDelta.x = radius - source.radius;
      } else if (handle === "radius:bottom") {
        const fixed = source.radius, radius = this.snapLength(Math.max(.025, (fixed - Math.min(local.y, fixed - .05)) / 2), target, true, bypassSnapping);
        target.radius = radius; centerDelta.y = source.radius - radius;
      } else if (handle === "radius:top") {
        const fixed = -source.radius, radius = this.snapLength(Math.max(.025, (Math.max(local.y, fixed + .05) - fixed) / 2), target, true, bypassSnapping);
        target.radius = radius; centerDelta.y = radius - source.radius;
      }
    } else return false;
    const worldDelta = rotateVector(centerDelta, rotation);
    if (source.snap && target.snap) target.snap.offset = { x: round(source.snap.offset.x + worldDelta.x), y: round(source.snap.offset.y + worldDelta.y) };
    else { target.x = round(source.x + worldDelta.x); target.y = round(source.y + worldDelta.y); }
    return true;
  }

  private snapLength(value: number, target: PrimitiveEditor, radius = false, bypass = false): number {
    if (bypass) return round(Math.max(.025, value));
    let snapped = this.state.drafting.snapToGrid ? snapUnit(value, this.state.drafting.gridStep) : value;
    if (this.state.drafting.smartSnap) {
      const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 4;
      const candidates = editorPrimitives(this.state).filter((part) => part !== target).flatMap((part) => primitiveLengths(part, radius));
      const nearest = candidates.reduce<number | null>((best, candidate) => best === null || Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, null);
      if (nearest !== null && Math.abs(nearest - value) <= threshold) snapped = nearest;
    }
    return round(Math.max(.025, snapped));
  }

  private snappedRotationDelta(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, rawDelta: number): number {
    const partIndex = selection.kind === "container" ? selection.index : "partIndex" in selection ? selection.partIndex ?? this.selectedPartIndex : this.selectedPartIndex;
    const source = primitiveFor(original, selection, partIndex);
    return source ? snapAngle(source.rotation + rawDelta) - source.rotation : snapAngle(rawDelta);
  }

  private snappedMoveDelta(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, dx: number, dy: number, partIndex?: number): Point {
    const index = selection.kind === "container" ? selection.index : partIndex ?? ("partIndex" in selection ? selection.partIndex : undefined) ?? this.selectedPartIndex;
    const source = primitiveFor(original, selection, index); if (!source) return { x: dx, y: dy };
    const position = resolvedPrimitivePosition(original, selection, index), step = this.state.drafting.gridStep;
    let x = position.x + dx, y = position.y + dy;
    if (this.state.drafting.snapToGrid) { x = snapUnit(x, step); y = snapUnit(y, step); }
    if (this.state.drafting.smartSnap) {
      const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 4;
      const others = editorPrimitives(original).filter((part) => part !== source);
      const xCandidates = [...others.map((part) => part.x), ...this.state.drafting.guides.map((guide) => guide.x)];
      const yCandidates = [...others.map((part) => part.y), ...this.state.drafting.guides.map((guide) => guide.y)];
      x = nearestWithin(x, xCandidates, threshold); y = nearestWithin(y, yCandidates, threshold);
    }
    return { x: round(x - position.x), y: round(y - position.y) };
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

  private snapMovedPart(selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): boolean {
    const parts = definitionParts(this.state, selection);
    const part = parts?.[partIndex]; if (!parts || !part) return false;
    const positions = resolveEditorTranslations(parts), ownPosition = positions.get(part.id) ?? { x: part.x, y: part.y };
    // Anchor capture is deliberately tight: it should feel intentional and must
    // not jump to a different corner/edge merely because it is in the vicinity.
    const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 10;
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
      this.problem = toProblem(this.state); this.resolved = resolveGeometry(this.problem); this.render();
      return true;
    }
    return false;
  }

  private transformSelectionGroup(original: EditorState, originalPlacements: Placement[], mode: "move" | "rotate" | "scale", amount: number, dy: number): void {
    const center = this.drag!.center!, selectedIds = new Map<string, Set<string>>(), entries: Array<{ owner: string; source: PrimitiveEditor; target: PrimitiveEditor; displayOffset: Point; position: Point }> = [];
    const definitions = this.selections.filter((entry): entry is Exclude<CadSelection, { kind: "placement" }> => entry.kind !== "placement");
    definitions.forEach((selection) => {
      const sourceParts = definitionParts(original, selection), targetParts = definitionParts(this.state, selection); if (!sourceParts || !targetParts) return;
      const owner = selection.kind === "container" ? "container" : `${selection.kind}:${selection.index}`;
      const indices = selection.kind === "container" ? [selection.index] : !("partIndex" in selection) || selection.partIndex === undefined ? sourceParts.map((_, index) => index) : [selection.partIndex];
      const positions = resolveEditorTranslations(sourceParts), displayOffset = selection.kind === "item" ? this.definitionDisplayOffset(selection) : { x: 0, y: 0 };
      const ids = selectedIds.get(owner) ?? new Set<string>(); selectedIds.set(owner, ids);
      indices.forEach((index) => {
        const source = sourceParts[index], target = targetParts[index]; if (!source || !target || ids.has(source.id)) return;
        ids.add(source.id); const position = positions.get(source.id) ?? { x: source.x, y: source.y };
        entries.push({ owner, source, target, displayOffset, position: { x: position.x + displayOffset.x, y: position.y + displayOffset.y } });
      });
    });
    entries.forEach(({ owner, source, target, displayOffset, position }) => {
      Object.assign(target, structuredClone(source));
      const targetSelected = !!source.snap && selectedIds.get(owner)?.has(source.snap.targetId);
      if (mode === "move") {
        if (source.snap) { if (!targetSelected) target.snap!.offset = { x: round(source.snap.offset.x + amount), y: round(source.snap.offset.y + dy) }; }
        else { target.x = round(source.x + amount); target.y = round(source.y + dy); }
        return;
      }
      if (mode === "rotate") {
        target.rotation = round(source.rotation + amount, 1);
        if (source.snap && targetSelected) target.snap!.offset = rotateVector(source.snap.offset, amount);
        else {
          const next = rotateAround(position, center, amount), dx = next.x - position.x, deltaY = next.y - position.y;
          if (source.snap) target.snap!.offset = { x: round(source.snap.offset.x + dx), y: round(source.snap.offset.y + deltaY) };
          else { target.x = round(next.x - displayOffset.x); target.y = round(next.y - displayOffset.y); }
        }
        return;
      }
      scalePrimitiveGeometry(target, amount);
      if (source.snap && targetSelected) target.snap!.offset = { x: round(source.snap.offset.x * amount), y: round(source.snap.offset.y * amount) };
      else {
        const next = { x: center.x + (position.x - center.x) * amount, y: center.y + (position.y - center.y) * amount }, dx = next.x - position.x, deltaY = next.y - position.y;
        if (source.snap) target.snap!.offset = { x: round(source.snap.offset.x + dx), y: round(source.snap.offset.y + deltaY) };
        else { target.x = round(next.x - displayOffset.x); target.y = round(next.y - displayOffset.y); }
      }
    });
    this.selections.forEach((selection) => {
      if (selection.kind !== "placement") return;
      const source = originalPlacements[selection.index], target = this.placements[selection.index]; if (!source || !target) return;
      Object.assign(target, source);
      if (mode === "move") { target.x = round(source.x + amount); target.y = round(source.y + dy); }
      else if (mode === "rotate") { const next = rotateAround(source, center, amount); target.x = round(next.x); target.y = round(next.y); target.rotation_deg = round(source.rotation_deg + amount, 1); }
      else { target.x = round(center.x + (source.x - center.x) * amount); target.y = round(center.y + (source.y - center.y) * amount); }
    });
  }

  private selectionBounds(selection: CadSelection): Bounds | null {
    if (selection.kind === "trace") {
      const trace = this.state.drafting.traceImages[selection.index]; if (!trace) return null;
      const points = [{ x: -trace.width / 2, y: -trace.height / 2 }, { x: trace.width / 2, y: -trace.height / 2 }, { x: trace.width / 2, y: trace.height / 2 }, { x: -trace.width / 2, y: trace.height / 2 }].map((point) => transformPoint(point, trace.rotation, trace.x, trace.y));
      return pointBounds(points);
    }
    if (selection.kind === "drafting") {
      const shape = this.state.drafting.shapes[selection.index], points = shape ? draftingWorldPoints(shape) : [];
      return points.length ? pointBounds(points) : null;
    }
    if (selection.kind === "guide") {
      const guide = this.state.drafting.guides[selection.index]; if (!guide) return null;
      const radius = Math.max(this.view.width, this.view.height) * .35, vector = rotateVector({ x: radius, y: 0 }, guide.rotation);
      return pointBounds([{ x: guide.x - vector.x, y: guide.y - vector.y }, { x: guide.x + vector.x, y: guide.y + vector.y }]);
    }
    if (selection.kind === "container") {
      const points = containerComponentIndices(this.state, selection.index).flatMap((index) => {
        const part = this.problem.container.parts[index];
        return part ? polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat() : [];
      });
      return points.length ? pointBounds(points) : null;
    }
    if (selection.kind === "exclusion") {
      const entry = this.problem.exclusions[selection.index];
      const part = entry?.shape.kind === "compound" && selection.partIndex !== undefined ? entry.shape.parts[selection.partIndex] : null;
      const points = part ? polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).flat() : entry ? polygons(entry.shape).flat() : [];
      return points.length ? pointBounds(points) : null;
    }
    if (selection.kind === "item") {
      const sample = this.itemSamples()[selection.index];
      if (selection.partIndex === undefined) return sample?.bounds ?? null;
      const points = sample?.sourcePolygons[selection.partIndex]?.flat() ?? [];
      return points.length ? pointBounds(points) : null;
    }
    const index = selection.index;
    const placement = this.placements[index];
    const item = placement && this.problem.items.find((entry) => entry.id === placement.item_id);
    if (!placement || !item) return null;
    const points = polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat();
    return points.length ? pointBounds(points) : null;
  }

  private dimensionMarkup(): string {
    const scale = this.view.width / Math.max(this.svg.clientWidth, 1), markup: string[] = [];
    const appendUnique = (polygons: Point[][], suffix = "") => {
      const shown = new Set<string>();
      polygons.forEach((polygon) => {
        const bounds = pointBounds(polygon), width = dimensionKey(bounds.width), height = dimensionKey(bounds.height);
        const showWidth = !shown.has(width); if (showWidth) shown.add(width);
        const showHeight = !shown.has(height); if (showHeight) shown.add(height);
        if (showWidth || showHeight) markup.push(dimensionsFor(bounds, scale, showWidth, showHeight, suffix));
      });
    };
    appendUnique(this.resolved.container);
    this.problem.exclusions.forEach((entry) => {
      const visible = this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? [];
      appendUnique(visible, " exclusion");
      const clearance = Math.max(this.problem.clearance.item_to_exclusion, entry.clearance);
      if (clearance > 0) appendUnique(visible.map((polygon) => offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * clearance)), " incl. clear");
    });
    return markup.join("");
  }

  private containerClearanceMarkup(): string {
    const distance = this.problem.clearance.item_to_boundary;
    if (!distance) return "";
    return this.resolved.container.map((polygon) => `<path class="cad-clearance" d="${path(offsetPolygon(polygon, contourArea(polygon) >= 0 ? -distance : distance))}"/>`).join("");
  }

  private exclusionClearanceMarkup(): string {
    return this.problem.exclusions.flatMap((entry) => (this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? []).map((polygon) => {
      const distance = Math.max(this.problem.clearance.item_to_exclusion, entry.clearance);
      return distance ? `<path class="cad-clearance danger" d="${path(offsetPolygon(polygon, contourArea(polygon) >= 0 ? distance : -distance))}"/>` : "";
    })).join("");
  }

  private itemSamples(): ItemSample[] {
    const container = this.containerBounds();
    const gap = Math.max(container.width * .08, 2);
    let top = container.maxY;
    return this.problem.items.map((item) => {
      const local = this.resolved.items.find((geometry) => geometry.id === item.id)?.polygons ?? [];
      const sourceLocal = sourcePartPolygons(item.shape);
      const localPoints = local.flat();
      if (!localPoints.length) {
        const emptyBounds = { minX: container.maxX + gap, minY: top, maxX: container.maxX + gap, maxY: top, width: 0, height: 0 };
        return { polygons: [], sourcePolygons: [], bounds: emptyBounds };
      }
      const bounds = pointBounds(localPoints);
      let offset = this.sampleOffsets.get(item.id);
      if (!offset) {
        offset = { x: container.maxX + gap - bounds.minX, y: top - bounds.maxY };
        this.sampleOffsets.set(item.id, offset);
      }
      const tx = offset.x;
      const ty = offset.y;
      const transformed = local.map((polygon) => polygon.map((point) => ({ x: point.x + tx, y: point.y + ty })));
      const sourcePolygons = sourceLocal.map((partPolygons) => partPolygons.map((polygon) => polygon.map((point) => ({ x: point.x + tx, y: point.y + ty }))));
      const resultBounds = pointBounds(transformed.flat());
      top = resultBounds.minY - Math.max(resultBounds.height * .55, 1.5);
      return { polygons: transformed, sourcePolygons, bounds: resultBounds };
    });
  }

  private definitionCenter(selection: Exclude<CadSelection, { kind: "placement" }>): Point {
    const bounds = this.selectionBounds(selection);
    return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
  }

  private moveDefinition(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, dx: number, dy: number, bypassSnapping = false): void {
    if (selection.kind === "guide") {
      const source = original.drafting.guides[selection.index], target = this.state.drafting.guides[selection.index]; if (!source || !target) return;
      target.x = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.x + dx, this.state.drafting.gridStep) : source.x + dx);
      target.y = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.y + dy, this.state.drafting.gridStep) : source.y + dy); return;
    }
    if (selection.kind === "trace") {
      const source = original.drafting.traceImages[selection.index], target = this.state.drafting.traceImages[selection.index]; if (!source || !target) return;
      target.x = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.x + dx, this.state.drafting.gridStep) : source.x + dx);
      target.y = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.y + dy, this.state.drafting.gridStep) : source.y + dy); return;
    }
    if (selection.kind === "drafting") {
      const source = original.drafting.shapes[selection.index], target = this.state.drafting.shapes[selection.index]; if (!source || !target) return;
      target.x = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.x + dx, this.state.drafting.gridStep) : source.x + dx);
      target.y = round(this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(source.y + dy, this.state.drafting.gridStep) : source.y + dy); return;
    }
    if (selection.kind === "container") {
      containerComponentIndices(original, selection.index).forEach((index) => {
        const source = original.containerParts[index]?.primitive, target = this.state.containerParts[index]?.primitive;
        if (source && target && !source.snap) { target.x = round(source.x + dx); target.y = round(source.y + dy); }
      });
      return;
    }
    if (selection.kind === "exclusion") {
      moveParts(original.exclusions[selection.index]?.parts, this.state.exclusions[selection.index]?.parts, dx, dy);
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
    if (selection.kind === "guide") { const source = original.drafting.guides[selection.index], target = this.state.drafting.guides[selection.index]; if (source && target) target.rotation = round(source.rotation + delta, 1); return; }
    if (selection.kind === "trace") { const source = original.drafting.traceImages[selection.index], target = this.state.drafting.traceImages[selection.index]; if (source && target) target.rotation = round(source.rotation + delta, 1); return; }
    if (selection.kind === "drafting") { const source = original.drafting.shapes[selection.index], target = this.state.drafting.shapes[selection.index]; if (source && target) target.rotation = round(source.rotation + delta, 1); return; }
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
      rotateParts(original.exclusions[selection.index]?.parts, this.state.exclusions[selection.index]?.parts, definitionGeometryCenter(original, selection), delta);
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
    if (selection.kind === "guide") return;
    if (selection.kind === "trace") { const source = original.drafting.traceImages[selection.index], target = this.state.drafting.traceImages[selection.index]; if (source && target) { target.width = round(source.width * factor); target.height = round(source.height * factor); } return; }
    if (selection.kind === "drafting") { const source = original.drafting.shapes[selection.index], target = this.state.drafting.shapes[selection.index]; if (source && target) target.points = source.points.map((point) => ({ x: round(point.x * factor), y: round(point.y * factor) })); return; }
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
      scaleParts(original.exclusions[selection.index]?.parts, this.state.exclusions[selection.index]?.parts, definitionGeometryCenter(original, selection), factor);
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
    this.state.drafting.traceImages.forEach((_, index) => { const bounds = this.selectionBounds({ kind: "trace", index }); if (bounds) points.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }); });
    this.state.drafting.shapes.forEach((shape) => points.push(...draftingWorldPoints(shape)));
    return points.length ? pointBounds(points) : this.containerBounds();
  }
}

interface ItemSample { polygons: Point[][]; sourcePolygons: Point[][][]; bounds: Bounds }

function draftingWorldPoints(shape: DraftingPath): Point[] {
  return shape.points.map((point) => transformPoint(point, shape.rotation, shape.x, shape.y));
}

function primitiveFor(state: EditorState, selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): PrimitiveEditor | null {
  if (selection.kind === "container") return state.containerParts[selection.index]?.primitive ?? null;
  if (selection.kind === "exclusion") return state.exclusions[selection.index]?.parts[partIndex] ?? null;
  if (selection.kind === "item") return state.items[selection.index]?.parts[partIndex] ?? null;
  return null;
}

function definitionParts(state: EditorState, selection: Exclude<CadSelection, { kind: "placement" }>): PrimitiveEditor[] | undefined {
  if (selection.kind === "container") return state.containerParts.map((entry) => entry.primitive);
  if (selection.kind === "exclusion") return state.exclusions[selection.index]?.parts;
  if (selection.kind === "item") return state.items[selection.index]?.parts;
  return undefined;
}

function definitionGeometryCenter(state: EditorState, selection: Exclude<CadSelection, { kind: "placement" }>): Point {
  const parts = definitionParts(state, selection) ?? [], positions = resolveEditorTranslations(parts);
  const points = parts.flatMap((part) => shapePoints(primitiveShape(part)).map((point) => {
    const position = positions.get(part.id) ?? { x: part.x, y: part.y };
    return transformPoint(point, part.rotation, position.x, position.y);
  }));
  if (!points.length) return { x: 0, y: 0 };
  const bounds = pointBounds(points);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function moveParts(source: PrimitiveEditor[] | undefined, target: PrimitiveEditor[] | undefined, dx: number, dy: number): void {
  if (!source || !target) return;
  target.forEach((part, index) => { const before = source[index]; if (before && !before.snap) { part.x = round(before.x + dx); part.y = round(before.y + dy); } });
}

function rotateParts(source: PrimitiveEditor[] | undefined, target: PrimitiveEditor[] | undefined, center: Point, delta: number): void {
  if (!source || !target) return;
  const radians = delta * Math.PI / 180;
  target.forEach((part, index) => {
    const before = source[index]; if (!before) return;
    part.rotation = round(before.rotation + delta, 1);
    if (before.snap) part.snap!.offset = rotateVector(before.snap.offset, delta);
    else {
      const x = before.x - center.x, y = before.y - center.y;
      part.x = round(center.x + x * Math.cos(radians) - y * Math.sin(radians));
      part.y = round(center.y + x * Math.sin(radians) + y * Math.cos(radians));
    }
  });
}

function scaleParts(source: PrimitiveEditor[] | undefined, target: PrimitiveEditor[] | undefined, center: Point, factor: number): void {
  if (!source || !target) return;
  target.forEach((part, index) => {
    const before = source[index]; if (!before) return;
    copyPrimitiveGeometry(part, before); scalePrimitiveGeometry(part, factor);
    if (before.snap) part.snap!.offset = { x: round(before.snap.offset.x * factor), y: round(before.snap.offset.y * factor) };
    else { part.x = round(center.x + (before.x - center.x) * factor); part.y = round(center.y + (before.y - center.y) * factor); }
  });
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
function rotateAround(point: Point, center: Point, rotation: number): Point {
  const delta = rotateVector({ x: point.x - center.x, y: point.y - center.y }, rotation);
  return { x: center.x + delta.x, y: center.y + delta.y };
}

function selectionFrom(element: SVGElement): CadSelection {
  const partIndex = element.dataset.cadPart === undefined ? undefined : Number(element.dataset.cadPart);
  return { kind: element.dataset.cadKind as CadSelection["kind"], index: Number(element.dataset.cadIndex), ...(partIndex === undefined ? {} : { partIndex }) } as CadSelection;
}

function sameSelection(a: CadSelection, b: CadSelection): boolean {
  return a.kind === b.kind && a.index === b.index && ("partIndex" in a ? a.partIndex : undefined) === ("partIndex" in b ? b.partIndex : undefined);
}

function lockReference(state: EditorState, selection: CadSelection, placements: Placement[]): EditorState["lockedEntities"][number] | null {
  if (selection.kind === "placement") {
    const id = placements[selection.index]?.item_id;
    return id ? { kind: "item", id } : null;
  }
  const id = selection.kind === "container" ? state.containerParts[selection.index]?.id
    : selection.kind === "exclusion" ? state.exclusions[selection.index]?.id
    : selection.kind === "item" ? state.items[selection.index]?.id
    : selection.kind === "guide" ? state.drafting.guides[selection.index]?.id
    : selection.kind === "drafting" ? state.drafting.shapes[selection.index]?.id
    : state.drafting.traceImages[selection.index]?.id;
  return id ? { kind: selection.kind, id } : null;
}

function parseDefinitionKey(value: string): Exclude<CadSelection, { kind: "placement" }> {
  const [kind, index] = value.split(":");
  return { kind: kind as Exclude<CadSelection, { kind: "placement" }>["kind"], index: Number(index) } as Exclude<CadSelection, { kind: "placement" }>;
}

function polygons(shape: Shape, rotation = 0, x = 0, y = 0): Point[][] {
  if (shape.kind === "compound") {
    const translations = resolveShapePartTranslations(shape.parts);
    return shape.parts.flatMap((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y)
      .map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y))));
  }
  return [shapePoints(shape).map((point) => transformPoint(point, rotation, x, y))];
}

function sourcePartPolygons(shape: Shape): Point[][][] {
  if (shape.kind !== "compound") return [polygons(shape)];
  const translations = resolveShapePartTranslations(shape.parts);
  return shape.parts.map((part, index) => polygons(part.shape, part.rotation_deg, translations[index].x, translations[index].y));
}

function transformPolygons(input: Point[][], rotation: number, x: number, y: number): Point[][] {
  return input.map((polygon) => polygon.map((point) => transformPoint(point, rotation, x, y)));
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

function compoundPath(polygons: Point[][]): string { return polygons.map(path).join(" "); }

function partColor(part: PrimitiveEditor | undefined, fallback: string): string {
  return part?.color && /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : fallback;
}
function containerColor(part: PrimitiveEditor | undefined): string { return part?.color === "#e7ebef" || !part?.color ? "var(--container-default)" : partColor(part, "var(--container-default)"); }

function contourArea(points: Point[]): number {
  return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function pointInCompound(point: Point, polygons: Point[][]): boolean { return polygons.reduce((inside, polygon) => inside !== pointInPolygon(point, polygon), false); }
function compoundsOverlap(a: Point[][], b: Point[][]): boolean {
  return a.some((left) => b.some((right) => polygonsOverlap(left, right)));
}
function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true;
  return edges(a).some(([a1, a2]) => edges(b).some(([b1, b2]) => segmentsIntersect(a1, a2, b1, b2)));
}
function compoundDistance(a: Point[][], b: Point[][]): number {
  if (!a.length || !b.length) return Infinity;
  return Math.min(...a.flatMap((left) => b.map((right) => polygonDistance(left, right))));
}
function compoundEdgeDistance(a: Point[][], b: Point[][]): number {
  if (!a.length || !b.length) return Infinity;
  return Math.min(...a.flatMap((left) => b.map((right) => polygonEdgeDistance(left, right))));
}
function polygonEdgeDistance(a: Point[], b: Point[]): number {
  return Math.min(...edges(a).flatMap(([a1, a2]) => edges(b).map(([b1, b2]) => Math.min(pointSegmentDistance(a1, b1, b2), pointSegmentDistance(a2, b1, b2), pointSegmentDistance(b1, a1, a2), pointSegmentDistance(b2, a1, a2)))));
}
function polygonDistance(a: Point[], b: Point[]): number {
  if (polygonsOverlap(a, b)) return 0;
  return Math.min(...edges(a).flatMap(([a1, a2]) => edges(b).map(([b1, b2]) => Math.min(pointSegmentDistance(a1, b1, b2), pointSegmentDistance(a2, b1, b2), pointSegmentDistance(b1, a1, a2), pointSegmentDistance(b2, a1, a2)))));
}
function edges(polygon: Point[]): Array<[Point, Point]> { return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]); }
function editorPrimitives(state: EditorState): PrimitiveEditor[] {
  return [...state.containerParts.map((entry) => entry.primitive), ...state.items.flatMap((item) => item.parts), ...state.exclusions.flatMap((entry) => entry.parts)];
}
function primitiveLengths(part: PrimitiveEditor, _forRadius: boolean): number[] {
  let width: number, height: number;
  if (part.kind === "rectangle") { width = part.width; height = part.height; }
  else if (part.kind === "triangle") { width = part.base; height = part.height; }
  else if (part.kind === "circle") { width = height = part.radius * 2; }
  else {
    const bounds = pointBounds(part.kind === "polygon" ? part.vertices : shapePoints(primitiveShape(part)));
    width = bounds.width; height = bounds.height;
  }
  const values = [width, height, width / 2, height / 2];
  if (part.kind === "circle") values.push(part.radius);
  return values;
}
function resolvedPrimitivePosition(state: EditorState, selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number): Point {
  const parts = selection.kind === "container" ? state.containerParts.map((entry) => entry.primitive)
    : selection.kind === "item" ? state.items[selection.index]?.parts ?? [] : state.exclusions[selection.index]?.parts ?? [];
  const primitive = selection.kind === "container" ? parts[selection.index] : parts[partIndex];
  return primitive ? resolveEditorTranslations(parts).get(primitive.id) ?? { x: primitive.x, y: primitive.y } : { x: 0, y: 0 };
}
function snapUnit(value: number, step: number): number { return Math.round(value / Math.max(step, 1e-6)) * Math.max(step, 1e-6); }
function snapAngle(value: number): number {
  const candidate = Math.round(value / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES;
  return Math.abs(candidate - value) <= ROTATION_CAPTURE_DEGREES ? candidate : value;
}
function nearestWithin(value: number, candidates: number[], threshold: number): number {
  const nearest = candidates.reduce<number | null>((best, candidate) => best === null || Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, null);
  return nearest !== null && Math.abs(nearest - value) <= threshold ? nearest : value;
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD <= 0 && cdA * cdB <= 0;
}
function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  if (!length) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1);
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function gridMarkup(view: View, unitStep: number): string {
  const desired = view.width / 36, multiple = Math.max(1, Math.ceil(desired / Math.max(unitStep, 1e-6)));
  const step = Math.max(unitStep, 1e-6) * multiple;
  const lines: string[] = [];
  for (let x = Math.floor(view.minX / step) * step; x <= view.minX + view.width; x += step) lines.push(`<line x1="${x}" y1="${-view.minY - view.height}" x2="${x}" y2="${-view.minY}"/>`);
  for (let y = Math.floor(view.minY / step) * step; y <= view.minY + view.height; y += step) lines.push(`<line x1="${view.minX}" y1="${-y}" x2="${view.minX + view.width}" y2="${-y}"/>`);
  return lines.join("");
}

function dimensionsFor(bounds: Bounds, scale: number, showWidth = true, showHeight = true, suffix = ""): string {
  const offset = Math.max(scale * 18, .35);
  const top = bounds.maxY + offset, right = bounds.maxX + offset;
  return `<g class="cad-dimensions">${showWidth ? `<line x1="${bounds.minX}" y1="${-top}" x2="${bounds.maxX}" y2="${-top}"/><text x="${(bounds.minX + bounds.maxX) / 2}" y="${-top - offset * .25}">${format(bounds.width)}${suffix}</text>` : ""}${showHeight ? `<line x1="${right}" y1="${-bounds.minY}" x2="${right}" y2="${-bounds.maxY}"/><text transform="translate(${right + offset * .4} ${-(bounds.minY + bounds.maxY) / 2}) rotate(-90)">${format(bounds.height)}${suffix}</text>` : ""}</g>`;
}

function dimensionKey(value: number): string { return value.toFixed(4); }

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
