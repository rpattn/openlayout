import { anchorPoint, primitiveAnchor, primitiveDependsOn, primitiveShape, resolveEditorTranslations, shapePoints, toProblem, transformPoint } from "./problem";
import { resolveGeometry } from "./geometry-resolver";
import { ANCHORS, editorColor, ITEM_COLORS } from "./design-tokens";
import { cadLockReference, sameCadSelection as sameSelection, type CadSelection } from "./cad-selection";
import { contourArea, offsetPolygon, roundedPolygonPath } from "./polygon-utils";
import { clamp, escapeHtml } from "./ui-utils";
import { compoundDistance, compoundEdgeDistance, compoundPath, compoundsOverlap, inverseTransformPoint, path, pointBounds, pointInCompound, polygons, resolveShapePartTranslations, rotateAround, rotateVector, sourcePartPolygons, transformPolygons, type Bounds } from "./cad-geometry";
import { engineeringDimensions, gridMarkup, linearDimensionMarkup } from "./cad-dimensions";
import { isDefinitionInteraction, isGroupInteraction, isPlacementInteraction, type CadInteraction, type CadView } from "./cad-interaction";
import { dimensionPreviewMarkup, draftPreviewMarkup, draftingMarkup, draftingTextLocalBounds, draftingWorldPoints, guidePreviewMarkup, traceImageHitMarkup, traceImageMarkup } from "./cad-drafting-markup";
import type { AnchorName, EditorState, PackingProblem, Placement, Point, PrimitiveEditor, ResolvedProblemGeometry } from "./types";

const ROTATION_SNAP_DEGREES = 15;
const ROTATION_CAPTURE_DEGREES = 2.5;

export type { CadSelection } from "./cad-selection";

export interface CadWorkspaceCallbacks {
  onSelect(selection: CadSelection | null, partIndex?: number, additive?: boolean): void;
  onMarquee(selections: CadSelection[], additive: boolean): void;
  onDefinitionChange(selection: Exclude<CadSelection, { kind: "placement" }>, previous: EditorState): void;
  onPlacementChange(previous: Placement[], current: Placement[]): void;
  onDraftingPath(points: Point[]): void;
  onConstructionGuide(point: Point, rotation: number): void;
  onDimensionCreate(start: Point, end: Point): void;
  onDimensionChange(index: number, previous: EditorState): void;
  onDimensionPositionChange(owner: string, previous: EditorState): void;
  onPlacementRejected?(index: number): void;
  onPlacementAdjusted?(index: number): void;
}

export class CadWorkspace {
  private state: EditorState;
  private problem: PackingProblem;
  private resolved: ResolvedProblemGeometry;
  private placementProblem: PackingProblem;
  private placementResolved: ResolvedProblemGeometry;
  private placements: Placement[] = [];
  private selection: CadSelection | null = null;
  private selections: CadSelection[] = [];
  private selectedPartIndex = 0;
  private view: CadView = { minX: -20, minY: -12, width: 40, height: 24 };
  private drag: CadInteraction | null = null;
  private dimensions = false;
  private clearance = false;
  private fitted = false;
  private respectFixed = true;
  private presentationMode: "edit" | "results" = "edit";
  private draftTool: "line" | "polyline" | null = null;
  private draftPoints: Point[] = [];
  private draftHover: Point | null = null;
  private guideTool: number | null = null;
  private guideHover: Point | null = null;
  private dimensionTool = false;
  private dimensionPoints: Point[] = [];
  private dimensionHover: Point | null = null;
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
    this.placementProblem = problem;
    this.placementResolved = this.resolved;
    this.bind();
    this.fit();
  }

  destroy(): void {
    this.svg.replaceWith(this.svg.cloneNode(false));
  }

  setModel(state: EditorState, problem: PackingProblem, placements: Placement[], refit = false, placementProblem = problem): void {
    this.state = state;
    this.problem = problem;
    this.resolved = resolveGeometry(problem);
    this.placementProblem = placementProblem;
    this.placementResolved = placementProblem === problem ? this.resolved : resolveGeometry(placementProblem);
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

  setPresentationMode(mode: "edit" | "results"): void {
    this.presentationMode = mode;
    this.svg.classList.toggle("results-mode", mode === "results");
    if (mode === "results" && this.selection?.kind !== "placement") {
      this.selection = null; this.selections = [];
    }
    this.render();
  }

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

  setDimensionTool(active: boolean): void {
    this.dimensionTool = active; this.dimensionPoints = []; this.dimensionHover = null;
    if (active) { this.setDraftTool(null); this.setGuideTool(null); }
    this.svg.classList.toggle("placing-dimension", active); this.render();
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

  async exportScenePng(width = 1600, height = 1000): Promise<Blob | null> {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;overflow:hidden`;
    const exportSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    exportSvg.style.width = `${width}px`; exportSvg.style.height = `${height}px`; host.append(exportSvg); document.body.append(host);
    try {
      const workspace = new CadWorkspace(exportSvg, this.state, this.problem, this.callbacks);
      workspace.setModel(this.state, this.problem, this.placements, true, this.placementProblem);
      workspace.setOverlays(this.dimensions, this.clearance);
      workspace.setPresentationMode(this.presentationMode);
      workspace.setSelection(null);
      return await workspace.rasterizeSvg(width, height);
    } finally {
      host.remove();
    }
  }

  private async rasterizeSvg(width: number, height: number): Promise<Blob | null> {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", String(width)); clone.setAttribute("height", String(height));
    clone.querySelectorAll(".cad-source-hit,.cad-trace-hit,.cad-text-hit,.cad-geometry-handle,.cad-part-move-handle,.cad-definition-handle,.cad-group-handle,.cad-snap-handle,.cad-marquee,.cad-draft-cursor").forEach((node) => node.remove());
    const css = Array.from(document.styleSheets).flatMap((sheet) => { try { return Array.from(sheet.cssRules).map((rule) => rule.cssText); } catch { return []; } }).join("\n");
    const computed = getComputedStyle(document.documentElement), variables = ["--canvas", "--surface", "--surface-soft", "--text", "--text-soft", "--muted", "--line", "--accent", "--amber", "--danger", "--constraint", "--constraint-danger", "--container-default"].map((name) => `${name}:${computed.getPropertyValue(name)};`).join("");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style"); style.textContent = `:root{${variables}}${css}`; clone.prepend(style);
    const source = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }), url = URL.createObjectURL(source), image = new Image();
    return await new Promise<Blob | null>((resolve) => {
      image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; canvas.getContext("2d")!.drawImage(image, 0, 0, width, height); URL.revokeObjectURL(url); canvas.toBlob(resolve, "image/png"); };
      image.onerror = () => { URL.revokeObjectURL(url); resolve(null); }; image.src = url;
    });
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
    this.svg.style.setProperty("--cad-edge-width", `${this.state.viewSettings.edgeThickness}px`);
    const editing = this.presentationMode === "edit";
    const samples = editing ? this.itemSamples() : [];
    this.svg.innerHTML = `<rect class="cad-background" data-cad-background x="${this.view.minX}" y="${y}" width="${this.view.width}" height="${this.view.height}"/>
      <g class="cad-grid">${editing && this.state.viewSettings.showGrid ? gridMarkup(this.view, this.state.drafting.gridStep) : ""}</g>
      ${editing ? traceImageMarkup(this.state) : ""}
      <g class="cad-container"><defs><clipPath id="container-union-clip"><path fill-rule="evenodd" d="${compoundPath(this.resolved.container)}"/></clipPath></defs>
        ${this.problem.container.parts.map((part, index) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path class="cad-part-color container" clip-path="url(#container-union-clip)" style="fill:${containerColor(this.state.containerParts[index]?.primitive)}" d="${path(polygon)}"/>`).join("")).join("")}
        <path data-unified-geometry="container" class="cad-region unified ${this.selections.some((entry) => entry.kind === "container") ? "selected" : ""}" style="fill:transparent" fill-rule="evenodd" d="${compoundPath(this.resolved.container)}"/>
        ${editing ? this.problem.container.parts.map((part, index) => polygons(part.shape, part.rotation_deg, part.translation.x, part.translation.y).map((polygon) => `<path ${this.isLocked({ kind: "container", index }) ? "" : `data-cad-kind="container" data-cad-index="${index}"`} class="cad-source-hit ${this.isLocked({ kind: "container", index }) ? "locked" : this.isSelected({ kind: "container", index }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("") : ""}</g>
      ${this.clearance ? this.containerClearanceMarkup() : ""}
      <g class="cad-exclusions">${this.problem.exclusions.map((entry, index) => {
        const selected = this.isSelected({ kind: "exclusion", index });
        const visible = this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? [];
        const sources = sourcePartPolygons(entry.shape);
        const locked = this.isLocked({ kind: "exclusion", index });
        return `<defs><clipPath id="exclusion-union-clip-${index}"><path fill-rule="evenodd" d="${compoundPath(visible)}"/></clipPath></defs>${sources.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color exclusion" clip-path="url(#exclusion-union-clip-${index})" style="fill:${editorColor(this.state.exclusions[index]?.parts[partIndex], "#ee716f")}" d="${path(polygon)}"/>`).join("")).join("")}<path data-unified-geometry="exclusion:${index}" class="cad-exclusion unified ${selected ? "selected" : ""}" style="fill:transparent" fill-rule="evenodd" d="${compoundPath(visible)}"/>${editing ? sources.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path ${locked ? "" : `data-cad-kind="exclusion" data-cad-index="${index}" data-cad-part="${partIndex}"`} class="cad-source-hit ${locked ? "locked" : this.isSelected({ kind: "exclusion", index, partIndex }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("") : ""}`;
      }).join("")}</g>
      ${this.clearance ? this.exclusionClearanceMarkup() : ""}
      <g class="cad-placements">${this.placements.map((placement, index) => this.placementMarkup(placement, index)).join("")}</g>
      <g class="cad-library">${samples.map((sample, index) => this.itemSampleMarkup(sample, index)).join("")}</g>
      ${this.dimensions ? this.dimensionMarkup() : ""}
      ${editing && this.dimensions ? this.customDimensionMarkup(scale) : ""}
      ${editing ? draftingMarkup(this.draftingMarkupContext()) : ""}
      ${editing ? traceImageHitMarkup(this.draftingMarkupContext()) : ""}
      ${this.selections.length > 1 ? this.multiSelectionMarkup(scale) : this.selection && (editing || this.selection.kind === "placement") ? this.selectionHandles(this.selection, scale) : ""}
      ${guidePreviewMarkup(this.guideTool, this.guideHover, this.view, scale)}
      ${draftPreviewMarkup(this.draftTool, this.draftPoints, this.draftHover, scale)}
      ${dimensionPreviewMarkup(this.dimensionTool, this.dimensionPoints, this.dimensionHover, scale, this.state.viewSettings)}
      ${this.marqueeMarkup()}`;
  }

  private isSelected(selection: CadSelection): boolean {
    return this.selections.some((entry) => sameSelection(entry, selection));
  }

  private isLocked(selection: CadSelection): boolean {
    const ref = cadLockReference(this.state, selection, this.placements);
    return !!ref && this.state.lockedEntities.some((entry) => entry.kind === ref.kind && entry.id === ref.id);
  }

  private draftingMarkupContext() {
    return {
      state: this.state,
      view: this.view,
      isSelected: (selection: Exclude<CadSelection, { kind: "placement" }>) => this.isSelected(selection),
      isLocked: (selection: Exclude<CadSelection, { kind: "placement" }>) => this.isLocked(selection),
    };
  }

  private snapDraftPoint(point: Point, bypass = false, excludedDraftPoint?: { shapeIndex: number; pointIndex: number }): Point {
    if (bypass) return { x: round(point.x), y: round(point.y) };
    if (this.state.drafting.smartSnap) {
      const nearest = this.nearestSnapPoint(point, this.sceneSnapPoints(excludedDraftPoint));
      if (nearest) return { x: round(nearest.x), y: round(nearest.y) };
    }
    if (!this.state.drafting.snapToGrid) return { x: round(point.x), y: round(point.y) };
    return { x: round(snapUnit(point.x, this.state.drafting.gridStep)), y: round(snapUnit(point.y, this.state.drafting.gridStep)) };
  }

  private pointerDown(event: PointerEvent): void {
    this.svg.focus();
    if (this.dimensionTool) {
      const point = this.snapDimensionPoint(this.eventPoint(event), event.altKey); this.dimensionPoints.push(point); this.dimensionHover = point;
      if (this.dimensionPoints.length === 2) { this.callbacks.onDimensionCreate(this.dimensionPoints[0], this.dimensionPoints[1]); this.setDimensionTool(false); }
      else this.render();
      return;
    }
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
        partIndex, geometryHandle: geometryHandle.dataset.geometryHandle ?? "", moved: false,
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
    const dimensionHit = (event.target as Element).closest<SVGElement>("[data-dimension-index]");
    if (dimensionHit) {
      const index = Number(dimensionHit.dataset.dimensionIndex), selected: CadSelection = { kind: "dimension", index };
      this.selection = selected; this.callbacks.onSelect(selected);
      this.drag = { mode: "dimension", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), originalState: structuredClone(this.state), partIndex: index, moved: false };
      this.svg.setPointerCapture(event.pointerId); this.render(); return;
    }
    const automaticDimension = (event.target as Element).closest<SVGElement>("[data-auto-dimension-owner]");
    if (automaticDimension) {
      const owner = automaticDimension.dataset.autoDimensionOwner!, axis = automaticDimension.dataset.autoDimensionAxis as "width" | "height" | "clearance";
      const selected: CadSelection = { kind: "auto-dimension", index: Number(automaticDimension.dataset.cadIndex ?? 0), owner, axis };
      this.selection = selected; this.callbacks.onSelect(selected);
      this.drag = { mode: "auto-dimension", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), originalState: structuredClone(this.state), dimensionOwner: owner, moved: false };
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
      this.drag = { mode: "rotate", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), placementIndex: index, originalPlacement: { ...placement }, originalPlacements: structuredClone(this.placements), moved: false };
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
        this.drag = { mode: "placement", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event), placementIndex: selection.index, originalPlacement: { ...placement }, originalPlacements: structuredClone(this.placements), moved: false };
        this.svg.setPointerCapture(event.pointerId);
      } else if (selection.kind === "container" || ((selection.kind === "item" || selection.kind === "exclusion") && selection.partIndex !== undefined)) {
        const partIndex = selection.kind === "container" ? selection.index : selection.partIndex!;
        this.drag = {
          mode: "part-move", startClient: { x: event.clientX, y: event.clientY }, startWorld: this.eventPoint(event),
          selection, partIndex, originalState: structuredClone(this.state), moved: false,
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
    if (this.dimensionTool && !this.drag) { this.dimensionHover = this.snapDimensionPoint(this.eventPoint(event), event.altKey); this.render(); return; }
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
      const world = this.snapDraftPoint(this.eventPoint(event), event.altKey, { shapeIndex: selection.index, pointIndex: this.drag.partIndex });
      const local = inverseTransformPoint(world, source.rotation, source.x, source.y);
      shape.points[this.drag.partIndex] = { x: round(local.x), y: round(local.y) };
      this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "dimension") {
      const index = this.drag.partIndex!, dimension = this.state.dimensions[index], source = this.drag.originalState?.dimensions[index];
      if (!dimension || !source) return;
      const current = this.eventPoint(event);
      const x = source.offset.x + current.x - this.drag.startWorld.x, y = source.offset.y + current.y - this.drag.startWorld.y;
      dimension.offset = { x: round(this.state.drafting.snapToGrid && !event.altKey ? snapUnit(x, this.state.drafting.gridStep) : x), y: round(this.state.drafting.snapToGrid && !event.altKey ? snapUnit(y, this.state.drafting.gridStep) : y) };
      this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "auto-dimension") {
      const owner = this.drag.dimensionOwner!, source = this.drag.originalState?.dimensionPositions[owner] ?? { x: 0, y: 0 }, current = this.eventPoint(event);
      const x = source.x + current.x - this.drag.startWorld.x, y = source.y + current.y - this.drag.startWorld.y;
      this.state.dimensionPositions[owner] = { x: round(this.state.drafting.snapToGrid && !event.altKey ? snapUnit(x, this.state.drafting.gridStep) : x), y: round(this.state.drafting.snapToGrid && !event.altKey ? snapUnit(y, this.state.drafting.gridStep) : y) };
      this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "group-move" || this.drag.mode === "group-rotate" || this.drag.mode === "group-scale") {
      const current = this.eventPoint(event), center = this.drag.center!;
      if (this.drag.mode === "group-move") this.transformSelectionGroup(this.drag.originalState, this.drag.originalPlacements, center, "move", current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y);
      else if (this.drag.mode === "group-rotate") {
        const start = Math.atan2(this.drag.startWorld.y - center.y, this.drag.startWorld.x - center.x), angle = Math.atan2(current.y - center.y, current.x - center.x);
        const rawDelta = (angle - start) * 180 / Math.PI;
        this.transformSelectionGroup(this.drag.originalState, this.drag.originalPlacements, center, "rotate", event.altKey ? rawDelta : snapAngle(rawDelta), 0);
      } else {
        const start = Math.max(Math.hypot(this.drag.startWorld.x - center.x, this.drag.startWorld.y - center.y), 1e-6);
        this.transformSelectionGroup(this.drag.originalState, this.drag.originalPlacements, center, "scale", clamp(Math.hypot(current.x - center.x, current.y - center.y) / start, .02, 50), 0);
      }
      this.problem = toProblem(this.state); this.resolved = resolveGeometry(this.problem); this.drag.moved = true; this.render(); return;
    }
    if (this.drag.mode === "definition" || this.drag.mode === "definition-rotate" || this.drag.mode === "definition-scale" || this.drag.mode === "geometry" || this.drag.mode === "snap-offset" || this.drag.mode === "part-move") {
      const selection = this.drag.selection!;
      const current = this.eventPoint(event);
      if (this.drag.mode === "definition") {
        const delta = event.altKey ? { x: current.x - this.drag.startWorld.x, y: current.y - this.drag.startWorld.y }
          : this.snappedMoveDelta(selection, this.drag.originalState, current.x - this.drag.startWorld.x, current.y - this.drag.startWorld.y);
        this.moveDefinition(selection, this.drag.originalState, delta.x, delta.y, event.altKey);
      } else if (this.drag.mode === "definition-rotate") {
        const center = this.drag.center;
        const start = Math.atan2(this.drag.startWorld.y - center.y, this.drag.startWorld.x - center.x);
        const angle = Math.atan2(current.y - center.y, current.x - center.x);
        const rawDelta = (angle - start) * 180 / Math.PI;
        this.rotateDefinition(selection, this.drag.originalState, event.altKey ? rawDelta : this.snappedRotationDelta(selection, this.drag.originalState, rawDelta));
      } else if (this.drag.mode === "definition-scale") {
        const center = this.drag.center;
        const startDistance = Math.max(Math.hypot(this.drag.startWorld.x - center.x, this.drag.startWorld.y - center.y), 1e-6);
        const factor = clamp(Math.hypot(current.x - center.x, current.y - center.y) / startDistance, .02, 50);
        this.scaleDefinition(selection, this.drag.originalState, factor);
      } else if (this.drag.mode === "snap-offset") {
        const before = primitiveFor(this.drag.originalState, selection, this.drag.partIndex);
        const part = primitiveFor(this.state, selection, this.drag.partIndex);
        if (before?.snap && part?.snap) part.snap.offset = {
          x: round(before.snap.offset.x + current.x - this.drag.startWorld.x),
          y: round(before.snap.offset.y + current.y - this.drag.startWorld.y),
        };
      } else if (this.drag.mode === "part-move") {
        const selectedParts = this.selections.filter((entry): entry is Extract<CadSelection, { kind: "container" | "item" | "exclusion" }> => entry.kind === "container" || entry.kind === "item" || entry.kind === "exclusion");
        const targets: Array<Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>> = selectedParts.length > 1 ? selectedParts : [selection as Extract<CadSelection, { kind: "container" | "item" | "exclusion" }>];
        const originalState = this.drag.originalState, draggedPartIndex = this.drag.partIndex;
        const rawDelta = { x: current.x - this.drag.startWorld.x, y: current.y - this.drag.startWorld.y };
        const draftingDelta = event.altKey ? null : this.draftingSnappedMoveDelta(selection, originalState, rawDelta.x, rawDelta.y, draggedPartIndex);
        const overConstructionAnchor = !event.altKey && this.nearConstituentSnapTarget(selection, draggedPartIndex, current);
        const delta = event.altKey ? rawDelta : draftingDelta
          ?? (overConstructionAnchor ? rawDelta : this.snappedMoveDelta(selection, originalState, rawDelta.x, rawDelta.y, draggedPartIndex));
        targets.forEach((entry) => this.movePart(entry, originalState, entry.kind === "container" ? entry.index : entry.partIndex ?? draggedPartIndex, delta.x, delta.y));
        this.drag.draftingSnapped = draftingDelta !== null;
      } else if (this.drag.mode === "geometry") {
        // Edge handles resize from the opposite edge by default. Holding Shift switches to
        // a centred, symmetric resize, matching the global scale cage without moving siblings.
        this.editDefinitionGeometry(selection, this.drag.originalState, this.drag.partIndex, this.drag.geometryHandle, current, this.drag.center, this.drag.rotation, event.altKey, event.shiftKey, this.drag.startWorld);
      }
      this.problem = toProblem(this.state);
      this.resolved = resolveGeometry(this.problem);
      this.drag.moved = true;
      this.render();
      return;
    }
    if (!isPlacementInteraction(this.drag)) return;
    const index = this.drag.placementIndex;
    const placement = this.placements[index];
    const original = this.drag.originalPlacement;
    const current = this.eventPoint(event);
    if (this.drag.mode === "placement") {
      let rawX = original.x + current.x - this.drag.startWorld.x, rawY = original.y + current.y - this.drag.startWorld.y;
      const item = this.placementProblem.items.find((entry) => entry.id === placement.item_id);
      const placementPoints = item ? polygons(item.shape, placement.rotation_deg, rawX, rawY).flat() : [{ x: rawX, y: rawY }];
      const placementBounds = pointBounds(placementPoints), placementAnchors = [
        ...placementPoints,
        ...ANCHORS.map((anchor) => anchorPoint(placementBounds, anchor)),
      ];
      const draftingAdjustment = !event.altKey && this.state.drafting.smartSnap
        ? this.draftingAnchorAdjustment(placementAnchors, this.draftingSnapPoints()) : null;
      if (draftingAdjustment) { rawX += draftingAdjustment.x; rawY += draftingAdjustment.y; }
      const snap = this.state.drafting.snapToGrid && !event.altKey;
      placement.x = round(snap && !draftingAdjustment ? snapUnit(rawX, this.state.drafting.gridStep) : rawX);
      placement.y = round(snap && !draftingAdjustment ? snapUnit(rawY, this.state.drafting.gridStep) : rawY);
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
      const anchored = drag.draftingSnapped || this.snapMovedPart(drag.selection, drag.partIndex);
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
    if (drag.moved && isPlacementInteraction(drag)) {
      if (this.respectFixed && drag.mode === "placement" && !this.placementSatisfiesConstraints(drag.placementIndex)) {
        const adjusted = this.closestFeasiblePlacement(drag.placementIndex, drag.originalPlacement);
        if (adjusted) { Object.assign(this.placements[drag.placementIndex], adjusted); this.callbacks.onPlacementChange(drag.originalPlacements, structuredClone(this.placements)); this.callbacks.onPlacementAdjusted?.(drag.placementIndex); }
        else { Object.assign(this.placements[drag.placementIndex], drag.originalPlacement); this.callbacks.onPlacementRejected?.(drag.placementIndex); }
      } else this.callbacks.onPlacementChange(drag.originalPlacements, structuredClone(this.placements));
    }
    if (drag.moved && isDefinitionInteraction(drag)) this.callbacks.onDefinitionChange(drag.selection, drag.originalState);
    if (drag.moved && drag.mode === "dimension") this.callbacks.onDimensionChange(drag.partIndex, drag.originalState);
    if (drag.moved && drag.mode === "auto-dimension") this.callbacks.onDimensionPositionChange(drag.dimensionOwner, drag.originalState);
    if (drag.moved && isGroupInteraction(drag)) {
      const definition = this.selections.find((entry): entry is Exclude<CadSelection, { kind: "placement" }> => entry.kind !== "placement");
      if (definition) this.callbacks.onDefinitionChange(definition, drag.originalState);
      if (this.selections.some((entry) => entry.kind === "placement")) this.callbacks.onPlacementChange(drag.originalPlacements, structuredClone(this.placements));
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
      ...this.state.drafting.texts.map((_, index) => ({ kind: "text", index }) as CadSelection),
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
    const itemIndex = this.placementProblem.items.findIndex((entry) => entry.id === placement.item_id);
    const item = this.placementProblem.items[itemIndex];
    if (!item) return "";
    const color = ITEM_COLORS[Math.max(itemIndex, 0) % ITEM_COLORS.length];
    const selected = this.isSelected({ kind: "placement", index });
    const locked = this.isLocked({ kind: "placement", index });
    const local = this.placementResolved.items.find((geometry) => geometry.id === item.id)?.polygons ?? [];
    const placed = transformPolygons(local, placement.rotation_deg, placement.x, placement.y);
    const sourceParts = sourcePartPolygons(item.shape).map((partPolygons) => transformPolygons(partPolygons, placement.rotation_deg, placement.x, placement.y));
    const editorItem = this.state.items.find((entry) => entry.id === item.id);
    const colored = sourceParts.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color item" style="fill:${editorColor(editorItem?.parts[partIndex], color)}" d="${path(polygon)}"/>`).join("")).join("");
    const interactive = this.presentationMode === "results" || placement.fixed;
    const paths = `${colored}<path ${locked || !interactive ? "" : `data-cad-kind="placement" data-cad-index="${index}"`} class="cad-placement unified ${locked ? "locked" : selected ? "selected" : ""} ${placement.fixed ? "fixed" : ""} ${interactive ? "" : "reference"}" fill-rule="evenodd" style="--item-color:${color};fill:transparent" d="${compoundPath(placed)}"/>${this.clearance && this.problem.clearance.item_to_item > 0 ? placed.map((polygon) => `<path class="cad-clearance item" d="${path(offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * this.problem.clearance.item_to_item / 2))}"/>`).join("") : ""}`;
    const fixedBadge = placement.fixed ? `<g class="cad-fixed-badge" aria-label="Fixed placement"><circle cx="${placement.x}" cy="${-placement.y}" r=".32"/><text x="${placement.x}" y="${-placement.y + .12}" text-anchor="middle">F</text></g>` : "";
    return `<g aria-label="${escapeHtml(placement.item_id)} placement ${index + 1}">${paths}${fixedBadge}</g>`;
  }

  private placementSatisfiesConstraints(index: number): boolean {
    const placement = this.placements[index], item = placement && this.placementProblem.items.find((entry) => entry.id === placement.item_id);
    const local = item && this.placementResolved.items.find((entry) => entry.id === item.id)?.polygons;
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
      const other = this.placements[otherIndex], otherItem = this.placementProblem.items.find((entry) => entry.id === other.item_id);
      const otherLocal = otherItem && this.placementResolved.items.find((entry) => entry.id === otherItem.id)?.polygons;
      if (!otherLocal) continue;
      const placed = transformPolygons(otherLocal, other.rotation_deg, other.x, other.y);
      if (compoundsOverlap(moved, placed) || compoundDistance(moved, placed) < this.problem.clearance.item_to_item - 1e-8) return false;
    }
    return true;
  }

  private closestFeasiblePlacement(index: number, original: Placement): Placement | null {
    const placement = this.placements[index], intended = { ...placement };
    const item = this.placementProblem.items.find((entry) => entry.id === placement.item_id), local = item && this.placementResolved.items.find((entry) => entry.id === item.id)?.polygons;
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
    return `${sample.sourcePolygons.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path class="cad-part-color item" style="fill:${editorColor(this.state.items[index]?.parts[partIndex], color)}" d="${path(polygon)}"/>`).join("")).join("")}<path data-unified-geometry="item:${index}" class="cad-item-sample unified ${selected ? "selected" : ""}" fill-rule="evenodd" style="--item-color:${color};fill:transparent" d="${compoundPath(sample.polygons)}"/>${sample.sourcePolygons.map((partPolygons, partIndex) => partPolygons.map((polygon) => `<path ${locked ? "" : `data-cad-kind="item" data-cad-index="${index}" data-cad-part="${partIndex}"`} class="cad-source-hit ${locked ? "locked" : this.isSelected({ kind: "item", index, partIndex }) ? "selected" : ""}" d="${path(polygon)}"/>`).join("")).join("")}${this.clearance && this.problem.clearance.item_to_item > 0 ? sample.polygons.map((polygon) => `<path class="cad-clearance item" d="${path(offsetPolygon(polygon, (contourArea(polygon) >= 0 ? 1 : -1) * this.problem.clearance.item_to_item / 2))}"/>`).join("") : ""}
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
      const bounds = pointBounds(shapePoints(primitiveShape(primitive))), gap = Math.max(8 * scale, .15);
      handles.push(
        { key: "bounds:left", point: { x: bounds.minX - gap, y: (bounds.minY + bounds.maxY) / 2 }, className: "bounds" },
        { key: "bounds:right", point: { x: bounds.maxX + gap, y: (bounds.minY + bounds.maxY) / 2 }, className: "bounds" },
        { key: "bounds:top", point: { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY + gap }, className: "bounds" },
        { key: "bounds:bottom", point: { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - gap }, className: "bounds" },
        { key: "bounds:top_left", point: { x: bounds.minX - gap, y: bounds.maxY + gap }, className: "bounds" },
        { key: "bounds:top_right", point: { x: bounds.maxX + gap, y: bounds.maxY + gap }, className: "bounds" },
        { key: "bounds:bottom_left", point: { x: bounds.minX - gap, y: bounds.minY - gap }, className: "bounds" },
        { key: "bounds:bottom_right", point: { x: bounds.maxX + gap, y: bounds.minY - gap }, className: "bounds" },
      );
      guides += `<rect class="cad-bezier-bounds" x="${bounds.minX + context.center.x}" y="${-(bounds.maxY + context.center.y)}" width="${bounds.width}" height="${bounds.height}" transform="rotate(${-context.rotation} ${context.center.x} ${-context.center.y})"/>`;
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
    // Bounds handles sit above coincident end knots so the resize cage remains draggable.
    handles.sort((left, right) => Number(left.className === "bounds") - Number(right.className === "bounds"));
    const controls = handles.map((entry) => {
      const point = transformPoint(entry.point, context.rotation, context.center.x, context.center.y);
      return `<circle class="cad-geometry-handle ${entry.className ?? ""}" data-geometry-target="${target}" data-geometry-part="${partIndex}" data-geometry-handle="${entry.key}" cx="${point.x}" cy="${-point.y}" r="${radius}"/>`;
    }).join("");
    return `${guides}${centerHandle}${controls}`;
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
    handle: string, world: Point, center: Point, rotation: number, bypassSnapping = false, symmetricResize = false, startWorld = world,
  ): void {
    const target = primitiveFor(this.state, selection, partIndex);
    const source = primitiveFor(original, selection, partIndex);
    if (!target || !source || target.kind !== source.kind) return;
    const draftingTarget = bypassSnapping ? null : this.nearestSnapPoint(world, this.draftingSnapPoints());
    const effectiveWorld = draftingTarget ?? world;
    const local = inverseTransformPoint(effectiveWorld, rotation, center.x, center.y);
    const preserveDraftingTarget = bypassSnapping || draftingTarget !== null;
    if (target.kind === "bezier" && source.kind === "bezier" && handle.startsWith("bounds:")) {
      const anchor = handle.slice(7), bounds = pointBounds(shapePoints(primitiveShape(source)));
      const startLocal = inverseTransformPoint(startWorld, rotation, center.x, center.y);
      const boundary = {
        x: anchor.includes("left") ? bounds.minX : anchor.includes("right") ? bounds.maxX : (bounds.minX + bounds.maxX) / 2,
        y: anchor.includes("bottom") ? bounds.minY : anchor.includes("top") ? bounds.maxY : (bounds.minY + bounds.maxY) / 2,
      };
      const adjusted = { x: boundary.x + local.x - startLocal.x, y: boundary.y + local.y - startLocal.y };
      this.resizeBezierBounds(target, source, anchor, adjusted, rotation, symmetricResize, preserveDraftingTarget);
      return;
    }
    // Radius handles remain centred by default; Shift anchors the opposite point. Polygonal edge
    // and Bézier cage handles use the conventional opposite-edge default and Shift centres them.
    const useOppositeHandle = target.kind === "circle" ? symmetricResize : !symmetricResize;
    if (useOppositeHandle && this.resizeFromOppositeHandle(target, source, handle, local, rotation, preserveDraftingTarget)) return;
    if (target.kind === "rectangle") {
      const anchor = handle.startsWith("resize:") ? handle.slice(7) : handle;
      if (anchor.includes("left") || anchor.includes("right") || anchor === "width") target.width = this.snapLength(Math.max(.05, Math.abs(local.x) * 2), target, false, preserveDraftingTarget);
      if (anchor.includes("top") || anchor.includes("bottom") || anchor === "height") target.height = this.snapLength(Math.max(.05, Math.abs(local.y) * 2), target, false, preserveDraftingTarget);
    } else if (target.kind === "triangle") {
      if (handle.startsWith("base:")) target.base = this.snapLength(Math.max(.05, Math.abs(local.x) * 2), target, false, preserveDraftingTarget);
      if (handle.startsWith("height:")) target.height = this.snapLength(Math.max(.05, Math.abs(local.y) * 2), target, false, preserveDraftingTarget);
    } else if (target.kind === "circle") {
      if (handle.startsWith("radius:")) target.radius = this.snapLength(Math.max(.025, Math.hypot(local.x, local.y)), target, true, preserveDraftingTarget);
    } else if (target.kind === "polygon" && handle.startsWith("vertex:")) {
      const index = Number(handle.split(":")[1]);
      const snappedWorld = this.snapDraftPoint(world, bypassSnapping), snappedLocal = inverseTransformPoint(snappedWorld, rotation, center.x, center.y);
      if (target.vertices[index]) target.vertices[index] = { x: round(snappedLocal.x), y: round(snappedLocal.y) };
    } else if (target.kind === "bezier" && source.kind === "bezier" && handle.startsWith("knot:")) {
      const index = Number(handle.split(":")[1]);
      const knot = target.knots[index], before = source.knots[index];
      if (knot && before) {
        const snappedWorld = this.snapDraftPoint(effectiveWorld, bypassSnapping), snappedLocal = inverseTransformPoint(snappedWorld, rotation, center.x, center.y);
        const dx = snappedLocal.x - before.point.x, dy = snappedLocal.y - before.point.y;
        knot.point = { x: round(snappedLocal.x), y: round(snappedLocal.y) };
        knot.control_in = { x: round(before.control_in.x + dx), y: round(before.control_in.y + dy) };
        knot.control_out = { x: round(before.control_out.x + dx), y: round(before.control_out.y + dy) };
      }
    } else if (target.kind === "bezier" && handle.startsWith("control_in:")) {
      const knot = target.knots[Number(handle.split(":")[1])]; if (knot) knot.control_in = { x: round(local.x), y: round(local.y) };
    } else if (target.kind === "bezier" && handle.startsWith("control_out:")) {
      const knot = target.knots[Number(handle.split(":")[1])]; if (knot) knot.control_out = { x: round(local.x), y: round(local.y) };
    }
  }

  private resizeBezierBounds(
    target: Extract<PrimitiveEditor, { kind: "bezier" }>, source: Extract<PrimitiveEditor, { kind: "bezier" }>,
    anchor: string, local: Point, rotation: number, symmetric: boolean, bypassSnapping: boolean,
  ): void {
    const sourceBounds = pointBounds(shapePoints(primitiveShape(source)));
    const next = { minX: sourceBounds.minX, maxX: sourceBounds.maxX, minY: sourceBounds.minY, maxY: sourceBounds.maxY };
    const snap = (value: number) => this.state.drafting.snapToGrid && !bypassSnapping ? snapUnit(value, this.state.drafting.gridStep) : value;
    if (anchor.includes("left") || anchor.includes("right")) {
      const value = snap(local.x), center = (sourceBounds.minX + sourceBounds.maxX) / 2;
      if (symmetric) {
        const half = Math.max(.025, Math.abs(value - center)); next.minX = center - half; next.maxX = center + half;
      } else if (anchor.includes("left")) next.minX = Math.min(value, sourceBounds.maxX - .05);
      else next.maxX = Math.max(value, sourceBounds.minX + .05);
    }
    if (anchor.includes("top") || anchor.includes("bottom")) {
      const value = snap(local.y), center = (sourceBounds.minY + sourceBounds.maxY) / 2;
      if (symmetric) {
        const half = Math.max(.025, Math.abs(value - center)); next.minY = center - half; next.maxY = center + half;
      } else if (anchor.includes("bottom")) next.minY = Math.min(value, sourceBounds.maxY - .05);
      else next.maxY = Math.max(value, sourceBounds.minY + .05);
    }
    const scaleX = (next.maxX - next.minX) / Math.max(sourceBounds.width, .05);
    const scaleY = (next.maxY - next.minY) / Math.max(sourceBounds.height, .05);
    const map = (point: Point): Point => ({
      x: round(next.minX + (point.x - sourceBounds.minX) * scaleX),
      y: round(next.minY + (point.y - sourceBounds.minY) * scaleY),
    });
    target.knots = source.knots.map((knot) => ({ point: map(knot.point), control_in: map(knot.control_in), control_out: map(knot.control_out) }));
    if (!symmetric && target.snap) {
      const centerDelta = rotateVector({
        x: (next.minX + next.maxX - sourceBounds.minX - sourceBounds.maxX) / 2,
        y: (next.minY + next.maxY - sourceBounds.minY - sourceBounds.maxY) / 2,
      }, rotation);
      const originalOffset = source.snap?.offset ?? { x: 0, y: 0 };
      target.snap.offset = { x: round(originalOffset.x + centerDelta.x), y: round(originalOffset.y + centerDelta.y) };
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
    const displayOffset = selection.kind === "item" ? this.definitionDisplayOffset(selection) : { x: 0, y: 0 };
    let x = position.x + dx, y = position.y + dy;
    if (this.state.drafting.snapToGrid) { x = snapUnit(x, step); y = snapUnit(y, step); }
    if (this.state.drafting.smartSnap) {
      const threshold = this.view.width / Math.max(this.svg.clientWidth, 1) * 4;
      const others = editorPrimitives(original).filter((part) => part !== source);
      const drafting = this.draftingSnapPoints();
      const adjustment = this.draftingAnchorAdjustment(
        this.movingPrimitiveSnapPoints(source, { x, y }, displayOffset), drafting,
      );
      if (adjustment) {
        x += adjustment.x; y += adjustment.y;
      } else {
        const xCandidates = [...others.map((part) => part.x), ...this.state.drafting.guides.map((guide) => guide.x), ...drafting.map((point) => point.x - displayOffset.x)];
        const yCandidates = [...others.map((part) => part.y), ...this.state.drafting.guides.map((guide) => guide.y), ...drafting.map((point) => point.y - displayOffset.y)];
        x = nearestWithin(x, xCandidates, threshold); y = nearestWithin(y, yCandidates, threshold);
      }
    }
    return { x: round(x - position.x), y: round(y - position.y) };
  }

  private draftingSnappedMoveDelta(selection: Exclude<CadSelection, { kind: "placement" }>, original: EditorState, dx: number, dy: number, partIndex: number): Point | null {
    if (!this.state.drafting.smartSnap) return null;
    const source = primitiveFor(original, selection, partIndex); if (!source) return null;
    const position = resolvedPrimitivePosition(original, selection, partIndex), displayOffset = this.definitionDisplayOffset(selection);
    const adjustment = this.draftingAnchorAdjustment(
      this.movingPrimitiveSnapPoints(source, { x: position.x + dx, y: position.y + dy }, displayOffset), this.draftingSnapPoints(),
    );
    return adjustment ? { x: round(dx + adjustment.x), y: round(dy + adjustment.y) } : null;
  }

  private nearConstituentSnapTarget(selection: Exclude<CadSelection, { kind: "placement" }>, partIndex: number, point: Point): boolean {
    const parts = definitionParts(this.state, selection), source = parts?.[partIndex];
    if (!parts || !source) return false;
    const positions = resolveEditorTranslations(parts), displayOffset = this.definitionDisplayOffset(selection);
    const capture = this.view.width / Math.max(this.svg.clientWidth, 1) * 14;
    return parts.some((target) => {
      if (target.id === source.id || primitiveDependsOn(parts, target.id, source.id)) return false;
      const position = positions.get(target.id) ?? { x: target.x, y: target.y };
      return ANCHORS.some((anchor) => {
        const targetPoint = primitiveAnchor(target, anchor, position);
        return Math.hypot(targetPoint.x + displayOffset.x - point.x, targetPoint.y + displayOffset.y - point.y) <= capture;
      });
    });
  }

  private movingPrimitiveSnapPoints(part: PrimitiveEditor, position: Point, displayOffset: Point): Point[] {
    const visiblePosition = { x: position.x + displayOffset.x, y: position.y + displayOffset.y };
    if (part.kind === "rectangle") return ANCHORS.map((anchor) => primitiveAnchor(part, anchor, visiblePosition));
    if (part.kind === "circle") return (["center", "top", "bottom", "left", "right"] as const).map((anchor) => primitiveAnchor(part, anchor, visiblePosition));
    if (part.kind === "triangle") return (["center", "top", "bottom_left", "bottom_right"] as const).map((anchor) => primitiveAnchor(part, anchor, visiblePosition));
    const localPoints = part.kind === "polygon" ? part.vertices : part.knots.map((knot) => knot.point);
    return [primitiveAnchor(part, "center", visiblePosition), ...localPoints.map((point) => transformPoint(point, part.rotation, visiblePosition.x, visiblePosition.y))];
  }

  private draftingAnchorAdjustment(sourcePoints: Point[], draftingPoints: Point[]): Point | null {
    const capture = this.view.width / Math.max(this.svg.clientWidth, 1) * 14;
    let best: { x: number; y: number; distance: number } | null = null;
    for (const source of sourcePoints) {
      for (const target of draftingPoints) {
        const x = target.x - source.x, y = target.y - source.y, distance = Math.hypot(x, y);
        if (distance <= capture && (!best || distance < best.distance)) best = { x, y, distance };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
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

  private transformSelectionGroup(original: EditorState, originalPlacements: Placement[], center: Point, mode: "move" | "rotate" | "scale", amount: number, dy: number): void {
    const selectedIds = new Map<string, Set<string>>(), entries: Array<{ owner: string; source: PrimitiveEditor; target: PrimitiveEditor; displayOffset: Point; position: Point }> = [];
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
    if (selection.kind === "text") {
      const entry = this.state.drafting.texts[selection.index]; if (!entry) return null;
      const bounds = draftingTextLocalBounds(entry), corners = [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }].map((point) => transformPoint(point, entry.rotation, entry.x, entry.y));
      return pointBounds(corners);
    }
    if (selection.kind === "drafting") {
      const shape = this.state.drafting.shapes[selection.index], points = shape ? draftingWorldPoints(shape) : [];
      return points.length ? pointBounds(points) : null;
    }
    if (selection.kind === "dimension") {
      const dimension = this.state.dimensions[selection.index];
      return dimension ? pointBounds([dimension.start, dimension.end, { x: dimension.start.x + dimension.offset.x, y: dimension.start.y + dimension.offset.y }, { x: dimension.end.x + dimension.offset.x, y: dimension.end.y + dimension.offset.y }]) : null;
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
    const item = placement && this.placementProblem.items.find((entry) => entry.id === placement.item_id);
    if (!placement || !item) return null;
    const points = polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat();
    return points.length ? pointBounds(points) : null;
  }

  private dimensionMarkup(): string {
    const scale = this.view.width / Math.max(this.svg.clientWidth, 1), markup: string[] = []; let automaticIndex = 0;
    const append = (points: Point[], owner: string, lane = 0, diameter = false) => {
      if (points.length) { markup.push(engineeringDimensions(pointBounds(points), scale, owner, this.state.viewSettings, lane, diameter, this.state.dimensionPositions[owner], this.state.dimensionOverrides, automaticIndex)); automaticIndex += diameter ? 1 : 2; }
    };
    append(this.resolved.container.flat(), "material", 0, this.state.containerParts.length === 1 && this.state.containerParts[0]?.primitive.kind === "circle");
    this.problem.exclusions.forEach((entry, index) => append((this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? []).flat(), `exclusion:${entry.id}`, index + 1, this.state.exclusions[index]?.parts.length === 1 && this.state.exclusions[index]?.parts[0]?.kind === "circle"));
    if (this.presentationMode === "edit") this.itemSamples().forEach((sample, index) => append(sample.polygons.flat(), `item:${this.problem.items[index]?.id ?? index + 1}`, this.problem.exclusions.length + index + 1, this.state.items[index]?.parts.length === 1 && this.state.items[index]?.parts[0]?.kind === "circle"));
    if (this.selection?.kind === "placement") {
      const placement = this.placements[this.selection.index], item = placement && this.placementProblem.items.find((entry) => entry.id === placement.item_id);
      const editorItem = placement && this.state.items.find((entry) => entry.id === placement.item_id);
      if (placement && item) append(polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat(), `placement:${placement.item_id}`, 0, editorItem?.parts.length === 1 && editorItem.parts[0]?.kind === "circle");
    }
    if (this.selection?.kind === "drafting") append(draftingWorldPoints(this.state.drafting.shapes[this.selection.index]), `drafting:${this.selection.index + 1}`);
    const clearance = (points: Point[], distance: number, owner: string, outward: boolean) => {
      if (!points.length || distance <= 0) return;
      const bounds = pointBounds(points), y = (bounds.minY + bounds.maxY) / 2;
      const start = { x: outward ? bounds.maxX : bounds.minX, y }, end = { x: outward ? bounds.maxX + distance : bounds.minX + distance, y };
      const calculated = `${distance.toFixed(this.state.viewSettings.dimensionPrecision)}${this.state.viewSettings.dimensionUnit ? ` ${this.state.viewSettings.dimensionUnit}` : ""} clear`;
      markup.push(linearDimensionMarkup({ id: owner, start, end, offset: this.state.dimensionPositions[owner] ?? { x: 0, y: 0 }, textOverride: this.state.dimensionOverrides[`${owner}:clearance`] || calculated }, scale, this.state.viewSettings, undefined, false, owner, owner, automaticIndex++, "clearance"));
    };
    clearance(this.resolved.container.flat(), this.problem.clearance.item_to_boundary, "clearance:boundary", false);
    this.problem.exclusions.forEach((entry) => clearance((this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? []).flat(), Math.max(this.problem.clearance.item_to_exclusion, entry.clearance), `clearance:exclusion:${entry.id}`, true));
    const sample = this.presentationMode === "edit" ? this.itemSamples()[0] : undefined; if (sample) clearance(sample.polygons.flat(), this.problem.clearance.item_to_item, "clearance:item-to-item", true);
    return markup.join("");
  }

  private customDimensionMarkup(scale: number): string {
    return this.state.dimensions.map((dimension, index) => linearDimensionMarkup(dimension, scale, this.state.viewSettings, index, this.selection?.kind === "dimension" && this.selection.index === index)).join("");
  }

  private snapDimensionPoint(point: Point, bypass: boolean): Point {
    return this.snapDraftPoint(point, bypass);
  }

  private nearestSnapPoint(point: Point, candidates: Point[]): Point | null {
    const nearest = candidates.reduce<Point | null>((best, candidate) => !best || Math.hypot(candidate.x - point.x, candidate.y - point.y) < Math.hypot(best.x - point.x, best.y - point.y) ? candidate : best, null);
    const capture = this.view.width / Math.max(this.svg.clientWidth, 1) * 14;
    return nearest && Math.hypot(nearest.x - point.x, nearest.y - point.y) <= capture ? nearest : null;
  }

  private draftingSnapPoints(excluded?: { shapeIndex: number; pointIndex: number }): Point[] {
    const points: Point[] = [];
    this.state.drafting.shapes.forEach((shape, shapeIndex) => {
      const world = draftingWorldPoints(shape);
      world.forEach((point, pointIndex) => {
        if (excluded?.shapeIndex !== shapeIndex || excluded.pointIndex !== pointIndex) points.push(point);
      });
      const edgeCount = shape.closed ? world.length : Math.max(0, world.length - 1);
      for (let index = 0; index < edgeCount; index += 1) {
        const start = world[index], end = world[(index + 1) % world.length];
        points.push({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
      }
    });
    return points;
  }

  private sceneSnapPoints(excludedDraftPoint?: { shapeIndex: number; pointIndex: number }): Point[] {
    const points = [...this.resolved.container.flat(), ...this.resolved.exclusions.flatMap((entry) => entry.polygons.flat())];
    this.itemSamples().forEach((sample) => points.push(...sample.polygons.flat()));
    this.placements.forEach((placement) => { const item = this.placementProblem.items.find((entry) => entry.id === placement.item_id); if (item) points.push(...polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat()); });
    points.push(...this.draftingSnapPoints(excludedDraftPoint));
    return points;
  }

  private containerClearanceMarkup(): string {
    const distance = this.problem.clearance.item_to_boundary;
    if (!distance) return "";
    return this.resolved.container.map((polygon) => {
      const offset = offsetPolygon(polygon, contourArea(polygon) >= 0 ? -distance : distance);
      return `<path class="cad-clearance" d="${roundedPolygonPath(offset, distance * .7)}"/>`;
    }).join("");
  }

  private exclusionClearanceMarkup(): string {
    return this.problem.exclusions.flatMap((entry) => (this.resolved.exclusions.find((geometry) => geometry.id === entry.id)?.polygons ?? []).map((polygon) => {
      const distance = Math.max(this.problem.clearance.item_to_exclusion, entry.clearance);
      const offset = offsetPolygon(polygon, contourArea(polygon) >= 0 ? distance : -distance);
      return distance ? `<path class="cad-clearance danger" d="${roundedPolygonPath(offset, distance * .7)}"/>` : "";
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
    if (selection.kind === "text") {
      const source = original.drafting.texts[selection.index], target = this.state.drafting.texts[selection.index]; if (!source || !target) return;
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
    if (selection.kind === "text") { const source = original.drafting.texts[selection.index], target = this.state.drafting.texts[selection.index]; if (source && target) target.rotation = round(source.rotation + delta, 1); return; }
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
    if (selection.kind === "text") { const source = original.drafting.texts[selection.index], target = this.state.drafting.texts[selection.index]; if (source && target) target.fontSize = round(Math.max(.05, source.fontSize * factor)); return; }
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
    if (this.presentationMode === "edit") this.itemSamples().forEach((sample) => points.push(...sample.polygons.flat()));
    this.placements.forEach((placement) => {
      const item = this.placementProblem.items.find((entry) => entry.id === placement.item_id);
      if (item) points.push(...polygons(item.shape, placement.rotation_deg, placement.x, placement.y).flat());
    });
    if (this.presentationMode === "edit") this.state.drafting.traceImages.forEach((trace, index) => { if (trace.visible === false) return; const bounds = this.selectionBounds({ kind: "trace", index }); if (bounds) points.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }); });
    if (this.presentationMode === "edit") {
      this.state.drafting.texts.forEach((_, index) => { const bounds = this.selectionBounds({ kind: "text", index }); if (bounds) points.push({ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }); });
      this.state.drafting.shapes.forEach((shape) => points.push(...draftingWorldPoints(shape)));
      this.state.dimensions.forEach((dimension) => points.push(dimension.start, dimension.end, { x: dimension.start.x + dimension.offset.x, y: dimension.start.y + dimension.offset.y }, { x: dimension.end.x + dimension.offset.x, y: dimension.end.y + dimension.offset.y }));
      Object.entries(this.state.dimensionPositions).forEach(([owner, position]) => {
        const source = this.dimensionOwnerPoints(owner); if (!source.length) return;
        const bounds = pointBounds(source);
        points.push({ x: bounds.minX + position.x, y: bounds.minY + position.y }, { x: bounds.maxX + position.x, y: bounds.maxY + position.y });
      });
    }
    return points.length ? pointBounds(points) : this.containerBounds();
  }

  private dimensionOwnerPoints(owner: string): Point[] {
    if (owner === "material" || owner === "clearance:boundary") return this.resolved.container.flat();
    if (owner === "clearance:item-to-item") return this.itemSamples()[0]?.polygons.flat() ?? [];
    if (owner.startsWith("exclusion:") || owner.startsWith("clearance:exclusion:")) {
      const id = owner.replace(/^clearance:/, "").slice("exclusion:".length);
      return this.resolved.exclusions.find((entry) => entry.id === id)?.polygons.flat() ?? [];
    }
    if (owner.startsWith("item:")) {
      const id = owner.slice("item:".length), index = this.problem.items.findIndex((entry) => entry.id === id);
      return this.itemSamples()[index]?.polygons.flat() ?? [];
    }
    return [];
  }
}

interface ItemSample { polygons: Point[][]; sourcePolygons: Point[][][]; bounds: Bounds }

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

function selectionFrom(element: SVGElement): CadSelection {
  const partIndex = element.dataset.cadPart === undefined ? undefined : Number(element.dataset.cadPart);
  if (element.dataset.cadKind === "auto-dimension") return { kind: "auto-dimension", index: Number(element.dataset.cadIndex), owner: element.dataset.autoDimensionOwner!, axis: element.dataset.autoDimensionAxis as "width" | "height" | "clearance" };
  return { kind: element.dataset.cadKind as CadSelection["kind"], index: Number(element.dataset.cadIndex), ...(partIndex === undefined ? {} : { partIndex }) } as CadSelection;
}

function parseDefinitionKey(value: string): Exclude<CadSelection, { kind: "placement" }> {
  const [kind, index] = value.split(":");
  return { kind: kind as Exclude<CadSelection, { kind: "placement" }>["kind"], index: Number(index) } as Exclude<CadSelection, { kind: "placement" }>;
}

function containerColor(part: PrimitiveEditor | undefined): string { return part?.color === "#e7ebef" || !part?.color ? "var(--container-default)" : editorColor(part, "var(--container-default)"); }

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
function round(value: number, digits = 3): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
