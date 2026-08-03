import {
  cloneItemAtParameter, makePrimitive, primitiveAnchor, primitiveShape,
  resolveEditorTranslations, shapePoints, transformPoint,
} from "./problem";
import type { AnchorName, EditorItem, EditorState, Point, PrimitiveEditor } from "./types";

const ANCHORS: AnchorName[] = ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"];
const COLORS = ["#4fc3a1", "#f4b860", "#7aa2f7", "#d98adf", "#ef6f6c", "#94c973"];

interface ViewBounds { minX: number; minY: number; width: number; height: number }
interface SnapCandidate { targetId: string; ownAnchor: AnchorName; targetAnchor: AnchorName; position: Point; point: Point; distance: number }
interface DragState { id: string; start: Point; original: Point; moved: boolean; mode: "move" | "resize" | "rotate" | "bezier"; anchor?: AnchorName; initialRotation?: number; bezierIndex?: number; bezierHandle?: "point" | "control_in" | "control_out"; wasSnapped?: boolean }

export class ShapeModeller {
  private selectedId: string;
  private drag: DragState | null = null;
  private snapCandidate: SnapCandidate | null = null;
  private view: ViewBounds;
  private readonly svg: SVGSVGElement;
  private readonly side: HTMLElement;
  private readonly sensitivity: HTMLElement;
  private readonly keyHandler = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.selected?.snap) {
      const position = resolveEditorTranslations(this.item.parts).get(this.selected.id)!;
      this.selected.x = position.x; this.selected.y = position.y; delete this.selected.snap; this.changed();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && event.target === document.body) this.deleteSelected();
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly state: EditorState,
    target: number | string,
    private readonly onChange: () => void,
    private readonly onClose: () => void,
  ) {
    this.targetKey = typeof target === "number" ? `item:${target}` : target;
    this.selectedId = this.item.parts[0]?.id ?? "";
    this.view = fitView(this.item.parts);
    root.innerHTML = `
      <div class="model-toolbar">
        <button class="button ghost" id="model-back">← Back to packing</button>
        <div class="model-title"><small>SHAPE MODELLER</small><strong>Constraint-aware item geometry</strong></div>
        <label>Editing<select id="model-target-select">${this.targetOptions()}</select></label>
        <div class="model-add"><span>Shape</span>${(["rectangle", "triangle", "circle", "polygon", "bezier"] as const).map((kind) => `<button data-add-shape="${kind}">${kind}</button>`).join("")}</div>
      </div>
      <div class="model-body">
        <aside id="model-side" class="model-side"></aside>
        <section class="model-stage">
          <div class="stage-help"><span>Drag to move · corners resize · amber handle rotates</span><span>Bézier knots and tangents edit the curve</span><span>Nearby anchors snap</span></div>
          <svg id="model-canvas" class="model-canvas" aria-label="Interactive item shape modeller"></svg>
        </section>
      </div>
      <section id="model-sensitivity" class="model-sensitivity"></section>`;
    this.svg = root.querySelector<SVGSVGElement>("#model-canvas")!;
    this.side = root.querySelector("#model-side")!;
    this.sensitivity = root.querySelector("#model-sensitivity")!;
    this.bindShell();
    this.render();
  }

  destroy(): void { window.removeEventListener("keydown", this.keyHandler); }

  private targetKey: string;
  private get isItem(): boolean { return this.targetKey.startsWith("item:"); }
  private get itemIndex(): number { return Number(this.targetKey.split(":")[1]); }
  private get exclusionIndex(): number { return Number(this.targetKey.split(":")[1]); }
  private get item(): EditorItem {
    if (this.targetKey === "container") return { id: "Container boundary", quantity: 1, rotations: "0", parts: [this.state.container] };
    if (this.targetKey.startsWith("exclusion:")) { const exclusion = this.state.exclusions[this.exclusionIndex]; return { id: `Exclusion · ${exclusion.id}`, quantity: 1, rotations: "0", parts: [exclusion.primitive] }; }
    return this.state.items[this.itemIndex];
  }
  private get selected(): PrimitiveEditor | undefined { return this.item.parts.find((part) => part.id === this.selectedId); }

  private targetOptions(): string {
    const options: Array<[string, string]> = [["container", "Container boundary"]];
    this.state.exclusions.forEach((entry, index) => options.push([`exclusion:${index}`, `Exclusion · ${entry.id}`]));
    this.state.items.forEach((item, index) => options.push([`item:${index}`, `Item · ${item.id}`]));
    return options.map(([value, label]) => `<option value="${value}" ${value === this.targetKey ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  private bindShell(): void {
    this.root.querySelector("#model-back")!.addEventListener("click", this.onClose);
    this.root.querySelector<HTMLSelectElement>("#model-target-select")!.addEventListener("change", (event) => {
      this.targetKey = (event.target as HTMLSelectElement).value;
      this.selectedId = this.item.parts[0]?.id ?? ""; this.view = fitView(this.item.parts); this.render();
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-add-shape]").forEach((button) => button.addEventListener("click", () => {
      const primitive = makePrimitive(button.dataset.addShape as PrimitiveEditor["kind"]);
      const center = { x: this.view.minX + this.view.width / 2, y: this.view.minY + this.view.height / 2 };
      if (this.isItem) {
        primitive.x = center.x; primitive.y = center.y; this.item.parts.push(primitive);
      } else {
        const previous = this.item.parts[0]; fitReplacement(primitive, previous);
        if (this.targetKey === "container") this.state.container = primitive; else this.state.exclusions[this.exclusionIndex].primitive = primitive;
      }
      this.selectedId = primitive.id; this.changed(true);
    }));
    this.svg.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.svg.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.svg.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.svg.addEventListener("pointercancel", (event) => this.pointerUp(event));
    window.addEventListener("keydown", this.keyHandler);
  }

  private render(): void { this.renderSide(); this.renderCanvas(); this.renderSensitivity(); }

  private renderSide(): void {
    const selected = this.selected;
    this.side.innerHTML = `
      <div class="model-side-heading"><div><small>PARTS</small><strong>${escapeHtml(this.item.id)}</strong></div><span>${this.item.parts.length}</span></div>
      <div class="layer-list">${this.item.parts.map((part, index) => `<button class="layer ${part.id === this.selectedId ? "selected" : ""}" data-layer="${part.id}"><span class="shape-icon ${part.kind}"></span><span><strong>${escapeHtml(part.id)}</strong><small>${part.kind}${part.snap ? " · snapped" : ""}</small></span><em>${index + 1}</em></button>`).join("")}</div>
      ${selected ? this.inspectorHtml(selected) : '<div class="empty-inspector">Add or select a shape part.</div>'}`;
    this.side.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((button) => button.addEventListener("click", () => { this.selectedId = button.dataset.layer!; this.render(); }));
    if (!selected) return;
    this.side.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-model-field]").forEach((input) => input.addEventListener("change", () => {
      const value = input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
      setField(selected, input.dataset.modelField!, value); this.changed(input.dataset.modelField === "rotation");
    }));
    this.side.querySelector<HTMLTextAreaElement>("[data-model-points]")?.addEventListener("change", (event) => {
      if (selected.kind !== "polygon") return;
      selected.vertices = (event.target as HTMLTextAreaElement).value.split(/\n|;/).map((line) => line.trim()).filter(Boolean).map((line) => { const [x, y] = line.split(/[ ,]+/).map(Number); return { x, y }; });
      this.changed(true);
    });
    this.side.querySelector<HTMLSelectElement>("#snap-target")?.addEventListener("change", (event) => {
      const targetId = (event.target as HTMLSelectElement).value;
      if (!targetId) delete selected.snap;
      else selected.snap = { targetId, ownAnchor: selected.snap?.ownAnchor ?? "center", targetAnchor: selected.snap?.targetAnchor ?? "center", offset: selected.snap?.offset ?? { x: 0, y: 0 } };
      this.changed();
    });
    this.side.querySelectorAll<HTMLSelectElement>("[data-snap-anchor]").forEach((select) => select.addEventListener("change", () => {
      if (!selected.snap) return; const field = select.dataset.snapAnchor as "ownAnchor" | "targetAnchor"; selected.snap[field] = select.value as AnchorName; this.changed();
    }));
    this.side.querySelectorAll<HTMLInputElement>("[data-snap-offset]").forEach((input) => input.addEventListener("change", () => {
      if (!selected.snap) return; selected.snap.offset[input.dataset.snapOffset as "x" | "y"] = Number(input.value); this.changed();
    }));
    this.side.querySelector("#detach-snap")?.addEventListener("click", () => {
      const position = resolveEditorTranslations(this.item.parts).get(selected.id)!; selected.x = position.x; selected.y = position.y; delete selected.snap; this.changed();
    });
    this.side.querySelector("#duplicate-part")?.addEventListener("click", () => this.duplicateSelected());
    this.side.querySelector("#delete-part-model")?.addEventListener("click", () => this.deleteSelected());
  }

  private inspectorHtml(part: PrimitiveEditor): string {
    const resolved = resolveEditorTranslations(this.item.parts).get(part.id) ?? { x: part.x, y: part.y };
    const dimensionFields = part.kind === "rectangle" ? modelNumber("Width", "width", part.width) + modelNumber("Height", "height", part.height)
      : part.kind === "triangle" ? modelNumber("Base", "base", part.base) + modelNumber("Height", "height", part.height)
        : part.kind === "circle" ? modelNumber("Radius", "radius", part.radius) + modelNumber("Segments", "segments", part.segments, 1)
          : part.kind === "polygon" ? `<label class="wide">Vertices<textarea rows="4" data-model-points>${part.vertices.map((point) => `${point.x}, ${point.y}`).join("\n")}</textarea></label>`
            : `${modelNumber("Curve segments", "segments", part.segments, 1)}<p class="hint wide">Drag the solid knots and hollow tangent handles directly on the canvas.</p>`;
    const targets = this.item.parts.filter((entry) => entry.id !== part.id && !dependsOn(this.item.parts, entry.id, part.id));
    const constraintPanel = this.isItem ? `<div class="snap-panel"><div class="snap-heading"><small>CONSTRAINT</small><strong>${part.snap ? "Anchored" : "Free position"}</strong></div>
        <label>Snap to<select id="snap-target"><option value="">Free position</option>${targets.map((target) => `<option value="${target.id}" ${part.snap?.targetId === target.id ? "selected" : ""}>${escapeHtml(target.id)}</option>`).join("")}</select></label>
        ${part.snap ? `<div class="field-grid two"><label>Own anchor<select data-snap-anchor="ownAnchor">${anchorOptions(part.snap.ownAnchor)}</select></label><label>Target anchor<select data-snap-anchor="targetAnchor">${anchorOptions(part.snap.targetAnchor)}</select></label><label>Offset X<input type="number" step=".1" value="${part.snap.offset.x}" data-snap-offset="x"></label><label>Offset Y<input type="number" step=".1" value="${part.snap.offset.y}" data-snap-offset="y"></label></div><button id="detach-snap" class="button ghost full">Detach at current position</button>` : '<p>Drag near another part’s center, edge midpoint, or corner to create a live relationship.</p>'}
      </div>` : `<div class="snap-panel"><div class="snap-heading"><small>CLEARANCE</small><strong>${format(this.targetClearance())}</strong></div><p>The dashed line previews the active ${this.targetKey === "container" ? "inward boundary" : "exclusion"} clearance.</p></div>`;
    return `<div class="model-inspector">
      <div class="inspector-title"><div><small>SELECTED</small><strong>${capitalize(part.kind)}</strong></div><span>${escapeHtml(part.id)}</span></div>
      <div class="field-grid two">${dimensionFields}${modelNumber("X", "x", part.snap ? resolved.x : part.x, .1, Boolean(part.snap))}${modelNumber("Y", "y", part.snap ? resolved.y : part.y, .1, Boolean(part.snap))}${modelNumber("Rotation°", "rotation", part.rotation, 1)}</div>
      ${constraintPanel}
      ${this.isItem ? '<div class="inline-actions"><button id="duplicate-part" class="button ghost">Duplicate</button><button id="delete-part-model" class="button danger">Delete</button></div>' : ""}
    </div>`;
  }

  private renderCanvas(): void {
    const translations = resolveEditorTranslations(this.item.parts);
    const grid = gridLines(this.view);
    const selected = this.selected;
    this.svg.setAttribute("viewBox", `${this.view.minX} ${-this.view.minY - this.view.height} ${this.view.width} ${this.view.height}`);
    this.svg.innerHTML = `<rect x="${this.view.minX}" y="${-this.view.minY - this.view.height}" width="${this.view.width}" height="${this.view.height}" class="model-bg"/>${grid}
      ${clearanceMarkup(this.item.parts, translations, this.targetKey === "container" ? -this.targetClearance() : this.targetClearance())}
      ${this.item.parts.map((part, index) => {
        const position = translations.get(part.id) ?? { x: part.x, y: part.y };
        return `<path data-part-id="${part.id}" class="model-shape ${part.id === this.selectedId ? "selected" : ""}" d="${pathForPart(part, position)}" fill="${COLORS[index % COLORS.length]}66" stroke="${COLORS[index % COLORS.length]}"/>`;
      }).join("")}
      ${selected ? selectionMarkup(selected, translations.get(selected.id)!, Math.max(this.view.width / Math.max(this.svg.clientWidth, 1) * 32, .35)) : ""}
      ${this.snapCandidate ? `<line class="snap-guide" x1="${this.snapCandidate.point.x - this.view.width}" y1="${-this.snapCandidate.point.y}" x2="${this.snapCandidate.point.x + this.view.width}" y2="${-this.snapCandidate.point.y}"/><line class="snap-guide" x1="${this.snapCandidate.point.x}" y1="${-this.snapCandidate.point.y - this.view.height}" x2="${this.snapCandidate.point.x}" y2="${-this.snapCandidate.point.y + this.view.height}"/>` : ""}`;
  }

  private renderSensitivity(): void {
    if (!this.isItem) {
      this.sensitivity.innerHTML = `<div class="geometry-context"><div><small>PROBLEM GEOMETRY</small><strong>${escapeHtml(this.item.id)}</strong></div><p>Use the same canvas handles to move, resize, rotate, or reshape this boundary. Dimensions are shown on the selected shape and the dashed outline is its active clearance.</p><dl><dt>Geometry</dt><dd>${this.selected?.kind ?? "—"}</dd><dt>Clearance</dt><dd>${format(this.targetClearance())}</dd></dl></div>`;
      return;
    }
    const parameterOptions = modelParameterOptions(this.item);
    if (!parameterOptions.some(([value]) => value === this.state.study.parameterKey)) this.state.study.parameterKey = parameterOptions[0]?.[0] ?? "";
    const values = studyValues(this.state.study.start, this.state.study.end, this.state.study.initial_step);
    this.sensitivity.innerHTML = `<div class="sensitivity-controls"><div><small>SENSITIVITY PREVIEW</small><strong>Geometry across the study</strong></div><label>Parameter<select id="model-study-parameter">${parameterOptions.map(([value, label]) => `<option value="${value}" ${value === this.state.study.parameterKey ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>${studyNumber("Start", "start", this.state.study.start)}${studyNumber("End", "end", this.state.study.end)}${studyNumber("Step", "initial_step", this.state.study.initial_step)}</div>
      <div class="sensitivity-steps">${values.map((value, index) => `<article class="shape-step ${index === 0 || index === values.length - 1 ? "extreme" : ""}"><header><strong>${format(value)}</strong><span>${index === 0 ? "START" : index === values.length - 1 ? "END" : `STEP ${index}`}</span></header>${itemSvg(cloneItemAtParameter(this.item, this.state.study.parameterKey, value))}</article>`).join("")}</div>`;
    this.sensitivity.querySelector<HTMLSelectElement>("#model-study-parameter")!.addEventListener("change", (event) => { this.state.study.parameterKey = (event.target as HTMLSelectElement).value; this.onChange(); this.renderSensitivity(); });
    this.sensitivity.querySelectorAll<HTMLInputElement>("[data-model-study]").forEach((input) => input.addEventListener("change", () => { setField(this.state.study, input.dataset.modelStudy!, Number(input.value)); this.onChange(); this.renderSensitivity(); }));
  }

  private pointerDown(event: PointerEvent): void {
    const bezierHandle = (event.target as Element).closest<SVGCircleElement>("[data-bezier-index]");
    if (bezierHandle && this.selected?.kind === "bezier") {
      const position = resolveEditorTranslations(this.item.parts).get(this.selected.id) ?? { x: this.selected.x, y: this.selected.y };
      this.drag = { id: this.selected.id, start: this.eventPoint(event), original: position, moved: false, mode: "bezier", bezierIndex: Number(bezierHandle.dataset.bezierIndex), bezierHandle: bezierHandle.dataset.bezierHandle as DragState["bezierHandle"] };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const rotateHandle = (event.target as Element).closest<SVGCircleElement>("[data-rotate-handle]");
    if (rotateHandle && this.selected) {
      const position = resolveEditorTranslations(this.item.parts).get(this.selected.id) ?? { x: this.selected.x, y: this.selected.y };
      this.drag = { id: this.selected.id, start: this.eventPoint(event), original: position, moved: false, mode: "rotate", initialRotation: this.selected.rotation };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const resizeHandle = (event.target as Element).closest<SVGCircleElement>("[data-resize-anchor]");
    if (resizeHandle && this.selected) {
      const position = resolveEditorTranslations(this.item.parts).get(this.selected.id) ?? { x: this.selected.x, y: this.selected.y };
      this.drag = { id: this.selected.id, start: this.eventPoint(event), original: position, moved: false, mode: "resize", anchor: resizeHandle.dataset.resizeAnchor as AnchorName };
      this.svg.setPointerCapture(event.pointerId);
      return;
    }
    const target = (event.target as Element).closest<SVGPathElement>("[data-part-id]");
    if (!target) return;
    this.selectedId = target.dataset.partId!;
    const part = this.selected!;
    const position = resolveEditorTranslations(this.item.parts).get(part.id) ?? { x: part.x, y: part.y };
    this.drag = { id: part.id, start: this.eventPoint(event), original: position, moved: false, mode: "move", wasSnapped: Boolean(part.snap) };
    this.svg.setPointerCapture(event.pointerId); this.render();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.drag) return;
    const current = this.eventPoint(event), part = this.selected!;
    if (this.drag.mode === "rotate") {
      const startAngle = Math.atan2(this.drag.start.y - this.drag.original.y, this.drag.start.x - this.drag.original.x);
      const currentAngle = Math.atan2(current.y - this.drag.original.y, current.x - this.drag.original.x);
      part.rotation = Math.round((this.drag.initialRotation! + (currentAngle - startAngle) * 180 / Math.PI) * 10) / 10;
      this.drag.moved = true; this.renderCanvas(); this.renderSensitivity(); return;
    }
    if (this.drag.mode === "bezier" && part.kind === "bezier") {
      const knot = part.knots[this.drag.bezierIndex!], handle = this.drag.bezierHandle!;
      const local = inverseTransformPoint(current, part.rotation, this.drag.original);
      if (handle === "point") {
        const delta = { x: local.x - knot.point.x, y: local.y - knot.point.y };
        knot.point = local; knot.control_in.x += delta.x; knot.control_in.y += delta.y; knot.control_out.x += delta.x; knot.control_out.y += delta.y;
      } else knot[handle] = local;
      this.drag.moved = true; this.renderCanvas(); this.renderSensitivity(); return;
    }
    if (this.drag.mode === "resize") {
      resizePart(part, this.drag.original, current, this.drag.anchor!);
      this.drag.moved = true;
      this.renderCanvas();
      this.renderSensitivity();
      return;
    }
    const raw = { x: this.drag.original.x + current.x - this.drag.start.x, y: this.drag.original.y + current.y - this.drag.start.y };
    this.drag.moved ||= Math.hypot(current.x - this.drag.start.x, current.y - this.drag.start.y) > this.view.width / 500;
    const candidate = findSnapCandidate(part, raw, this.item.parts, this.view.width / Math.max(this.svg.clientWidth, 1) * 13);
    this.snapCandidate = candidate;
    if (candidate) {
      part.x = candidate.position.x; part.y = candidate.position.y;
      part.snap = { targetId: candidate.targetId, ownAnchor: candidate.ownAnchor, targetAnchor: candidate.targetAnchor, offset: { x: 0, y: 0 } };
    } else if (this.drag.wasSnapped && part.snap) {
      const base = positionForSnap(part, this.item.parts);
      part.x = raw.x; part.y = raw.y;
      part.snap.offset = { x: raw.x - base.x, y: raw.y - base.y };
    } else {
      part.x = raw.x; part.y = raw.y; delete part.snap;
    }
    this.renderCanvas();
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag) return;
    this.svg.releasePointerCapture(event.pointerId); const moved = this.drag.moved, mode = this.drag.mode; this.drag = null; this.snapCandidate = null;
    if (moved) this.changed(mode !== "move"); else this.render();
  }

  private eventPoint(event: PointerEvent): Point {
    const point = this.svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(this.svg.getScreenCTM()!.inverse()); return { x: local.x, y: -local.y };
  }

  private duplicateSelected(): void {
    const selected = this.selected; if (!selected || !this.isItem) return; const copy = structuredClone(selected); let suffix = 1; do { copy.id = `${selected.id}-copy-${suffix++}`; } while (this.item.parts.some((part) => part.id === copy.id)); copy.x += .7; copy.y += .7; delete copy.snap; this.item.parts.push(copy); this.selectedId = copy.id; this.changed(true);
  }

  private deleteSelected(): void {
    if (!this.selected || !this.isItem) return; const id = this.selected.id; const item = this.item; item.parts = item.parts.filter((part) => part.id !== id); item.parts.forEach((part) => { if (part.snap?.targetId === id) delete part.snap; }); this.selectedId = item.parts[0]?.id ?? ""; this.changed(true);
  }

  private targetClearance(): number {
    if (this.targetKey === "container") return this.state.clearance.item_to_boundary;
    if (this.targetKey.startsWith("exclusion:")) return Math.max(this.state.clearance.item_to_exclusion, this.state.exclusions[this.exclusionIndex].clearance);
    return this.state.clearance.item_to_item / 2;
  }

  private changed(refit = false): void { if (refit) this.view = fitView(this.item.parts); this.onChange(); this.render(); }
}

function findSnapCandidate(part: PrimitiveEditor, raw: Point, parts: PrimitiveEditor[], threshold: number): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  const translations = resolveEditorTranslations(parts.filter((entry) => entry.id !== part.id));
  for (const target of parts) {
    if (target.id === part.id || dependsOn(parts, target.id, part.id)) continue;
    const targetPosition = translations.get(target.id) ?? { x: target.x, y: target.y };
    for (const ownAnchor of ANCHORS) for (const targetAnchor of ANCHORS) {
      const own = primitiveAnchor(part, ownAnchor, raw), targetPoint = primitiveAnchor(target, targetAnchor, targetPosition);
      const distance = Math.hypot(own.x - targetPoint.x, own.y - targetPoint.y);
      if (distance <= threshold && (!best || distance < best.distance)) best = { targetId: target.id, ownAnchor, targetAnchor, position: { x: raw.x + targetPoint.x - own.x, y: raw.y + targetPoint.y - own.y }, point: targetPoint, distance };
    }
  }
  return best;
}

function dependsOn(parts: PrimitiveEditor[], startId: string, targetId: string): boolean {
  const byId = new Map(parts.map((part) => [part.id, part])); const seen = new Set<string>(); let current = byId.get(startId);
  while (current?.snap && !seen.has(current.id)) { if (current.snap.targetId === targetId) return true; seen.add(current.id); current = byId.get(current.snap.targetId); }
  return false;
}

function selectionMarkup(part: PrimitiveEditor, position: Point, handleOffset: number): string {
  const points = ANCHORS.map((anchor) => ({ anchor, point: primitiveAnchor(part, anchor, position) }));
  const byAnchor = new Map(points.map((entry) => [entry.anchor, entry.point]));
  const center = byAnchor.get("center")!, top = byAnchor.get("top")!;
  const length = Math.hypot(top.x - center.x, top.y - center.y) || 1;
  const rotate = { x: top.x + (top.x - center.x) / length * handleOffset, y: top.y + (top.y - center.y) / length * handleOffset };
  const outline = ["top_left", "top_right", "bottom_right", "bottom_left"].map((anchor) => byAnchor.get(anchor as AnchorName)!);
  const bezier = part.kind === "bezier" ? bezierControlMarkup(part, position) : "";
  return `<path class="selection-box" d="${outline.map((point, index) => `${index ? "L" : "M"}${point.x},${-point.y}`).join(" ")} Z"/>${dimensionMarkup(byAnchor, handleOffset)}<line class="rotate-stem" x1="${top.x}" y1="${-top.y}" x2="${rotate.x}" y2="${-rotate.y}"/><circle class="rotate-handle" data-rotate-handle cx="${rotate.x}" cy="${-rotate.y}" r=".13"/>${points.map(({ anchor, point }) => `<circle class="anchor-handle ${anchor === "center" ? "center" : anchor}" data-anchor="${anchor}" ${anchor === "center" ? "" : `data-resize-anchor="${anchor}"`} cx="${point.x}" cy="${-point.y}" r=".11"/>`).join("")}${bezier}`;
}

function positionForSnap(part: PrimitiveEditor, parts: PrimitiveEditor[]): Point {
  if (!part.snap) return { x: part.x, y: part.y };
  const target = parts.find((entry) => entry.id === part.snap!.targetId);
  if (!target) return { x: part.x, y: part.y };
  const targetPosition = resolveEditorTranslations(parts.filter((entry) => entry.id !== part.id)).get(target.id) ?? { x: target.x, y: target.y };
  const own = primitiveAnchor(part, part.snap.ownAnchor), targetPoint = primitiveAnchor(target, part.snap.targetAnchor, targetPosition);
  return { x: targetPoint.x - own.x, y: targetPoint.y - own.y };
}

function dimensionMarkup(anchors: Map<AnchorName, Point>, offset: number): string {
  const center = anchors.get("center")!, top = anchors.get("top")!, right = anchors.get("right")!;
  const topLeft = anchors.get("top_left")!, topRight = anchors.get("top_right")!, bottomRight = anchors.get("bottom_right")!;
  const topLength = Math.hypot(top.x - center.x, top.y - center.y) || 1, rightLength = Math.hypot(right.x - center.x, right.y - center.y) || 1;
  const up = { x: (top.x - center.x) / topLength * offset * .52, y: (top.y - center.y) / topLength * offset * .52 };
  const outward = { x: (right.x - center.x) / rightLength * offset, y: (right.y - center.y) / rightLength * offset };
  const a = { x: topLeft.x + up.x, y: topLeft.y + up.y }, b = { x: topRight.x + up.x, y: topRight.y + up.y };
  const c = { x: topRight.x + outward.x, y: topRight.y + outward.y }, d = { x: bottomRight.x + outward.x, y: bottomRight.y + outward.y };
  const width = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y), height = Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y);
  return `<g class="model-dimensions"><line x1="${a.x}" y1="${-a.y}" x2="${b.x}" y2="${-b.y}"/><text x="${(a.x + b.x) / 2}" y="${-(a.y + b.y) / 2}">${format(width)}</text><line x1="${c.x}" y1="${-c.y}" x2="${d.x}" y2="${-d.y}"/><text x="${(c.x + d.x) / 2}" y="${-(c.y + d.y) / 2}">${format(height)}</text></g>`;
}

function clearanceMarkup(parts: PrimitiveEditor[], translations: Map<string, Point>, distance: number): string {
  if (Math.abs(distance) < 1e-9) return "";
  return parts.map((part) => {
    const position = translations.get(part.id) ?? { x: part.x, y: part.y };
    const polygon = shapePoints(primitiveShape(part)).map((point) => transformPoint(point, part.rotation, position.x, position.y));
    const offset = offsetPolygon(polygon, distance);
    return `<path class="model-clearance" d="${offset.map((point, index) => `${index ? "L" : "M"}${point.x},${-point.y}`).join(" ")} Z"/>`;
  }).join("");
}

function offsetPolygon(points: Point[], distance: number): Point[] {
  if (points.length < 3) return points;
  const area = points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
  const direction = area >= 0 ? 1 : -1;
  const lines = points.map((point, index) => { const next = points[(index + 1) % points.length], dx = next.x - point.x, dy = next.y - point.y, length = Math.hypot(dx, dy) || 1; return { point: { x: point.x + direction * dy / length * distance, y: point.y - direction * dx / length * distance }, direction: { x: dx, y: dy } }; });
  return points.map((_, index) => lineIntersection(lines[(index + lines.length - 1) % lines.length], lines[index]) ?? lines[index].point);
}

function lineIntersection(a: { point: Point; direction: Point }, b: { point: Point; direction: Point }): Point | null {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = b.point.x - a.point.x, dy = b.point.y - a.point.y, amount = (dx * b.direction.y - dy * b.direction.x) / cross;
  return { x: a.point.x + amount * a.direction.x, y: a.point.y + amount * a.direction.y };
}

function bezierControlMarkup(part: Extract<PrimitiveEditor, { kind: "bezier" }>, position: Point): string {
  return part.knots.map((knot, index) => {
    const point = transformPoint(knot.point, part.rotation, position.x, position.y);
    const incoming = transformPoint(knot.control_in, part.rotation, position.x, position.y);
    const outgoing = transformPoint(knot.control_out, part.rotation, position.x, position.y);
    return `<line class="bezier-tangent" x1="${incoming.x}" y1="${-incoming.y}" x2="${outgoing.x}" y2="${-outgoing.y}"/><circle class="bezier-control" data-bezier-index="${index}" data-bezier-handle="control_in" cx="${incoming.x}" cy="${-incoming.y}" r=".1"/><circle class="bezier-control" data-bezier-index="${index}" data-bezier-handle="control_out" cx="${outgoing.x}" cy="${-outgoing.y}" r=".1"/><circle class="bezier-knot" data-bezier-index="${index}" data-bezier-handle="point" cx="${point.x}" cy="${-point.y}" r=".12"/>`;
  }).join("");
}

function inverseTransformPoint(point: Point, rotation: number, position: Point): Point {
  const angle = -rotation * Math.PI / 180, x = point.x - position.x, y = point.y - position.y;
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) };
}

function resizePart(part: PrimitiveEditor, center: Point, worldPoint: Point, anchor: AnchorName): void {
  const angle = -part.rotation * Math.PI / 180;
  const dx = worldPoint.x - center.x, dy = worldPoint.y - center.y;
  const local = { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
  const resizeX = anchor.includes("left") || anchor.includes("right");
  const resizeY = anchor.includes("top") || anchor.includes("bottom");
  const width = Math.max(.1, Math.abs(local.x) * 2), height = Math.max(.1, Math.abs(local.y) * 2);
  if (part.kind === "circle") part.radius = Math.max(.05, Math.hypot(local.x, local.y));
  else if (part.kind === "rectangle") { if (resizeX) part.width = width; if (resizeY) part.height = height; }
  else if (part.kind === "triangle") { if (resizeX) part.base = width; if (resizeY) part.height = height; }
  else if (part.kind === "polygon") { if (resizeX) scalePolygon(part.vertices, "x", width); if (resizeY) scalePolygon(part.vertices, "y", height); }
  else { if (resizeX) scaleBezier(part, "x", width); if (resizeY) scaleBezier(part, "y", height); }
}

function scalePolygon(points: Point[], axis: "x" | "y", target: number): void {
  const extent = Math.max(...points.map((point) => Math.abs(point[axis]))) * 2;
  if (extent > 0) points.forEach((point) => { point[axis] *= target / extent; });
}

function scaleBezier(part: Extract<PrimitiveEditor, { kind: "bezier" }>, axis: "x" | "y", target: number): void {
  const points = part.knots.flatMap((knot) => [knot.point, knot.control_in, knot.control_out]);
  const extent = Math.max(...points.map((point) => Math.abs(point[axis]))) * 2;
  if (extent > 0) points.forEach((point) => { point[axis] *= target / extent; });
}

function fitReplacement(replacement: PrimitiveEditor, previous: PrimitiveEditor): void {
  const center = primitiveAnchor(previous, "center", { x: previous.x, y: previous.y });
  const topLeft = primitiveAnchor(previous, "top_left"), topRight = primitiveAnchor(previous, "top_right"), bottomRight = primitiveAnchor(previous, "bottom_right");
  const width = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y), height = Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y);
  replacement.id = previous.id; replacement.x = center.x; replacement.y = center.y; replacement.rotation = previous.rotation;
  if (replacement.kind === "rectangle") { replacement.width = width; replacement.height = height; }
  else if (replacement.kind === "triangle") { replacement.base = width; replacement.height = height; }
  else if (replacement.kind === "circle") replacement.radius = Math.max(.05, Math.min(width, height) / 2);
  else if (replacement.kind === "polygon") { scalePolygon(replacement.vertices, "x", width); scalePolygon(replacement.vertices, "y", height); }
  else { scaleBezier(replacement, "x", width); scaleBezier(replacement, "y", height); }
}

function pathForPart(part: PrimitiveEditor, position: Point): string {
  const points = shapePoints(primitiveShape(part)).map((point) => transformPoint(point, part.rotation, position.x, position.y));
  return points.map((point, index) => `${index ? "L" : "M"}${point.x},${-point.y}`).join(" ") + " Z";
}

function itemSvg(item: EditorItem): string {
  const translations = resolveEditorTranslations(item.parts); const polygons = item.parts.map((part) => shapePoints(primitiveShape(part)).map((point) => transformPoint(point, part.rotation, translations.get(part.id)!.x, translations.get(part.id)!.y)));
  const all = polygons.flat(); const bounds = boundsOf(all); const padding = Math.max(bounds.width, bounds.height) * .18 + .2;
  const view = `${bounds.minX - padding} ${-bounds.maxY - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`;
  return `<svg viewBox="${view}" aria-label="Sensitivity shape at parameter value">${polygons.map((points, index) => `<path d="${points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${point.x},${-point.y}`).join(" ")} Z" fill="${COLORS[index % COLORS.length]}66" stroke="${COLORS[index % COLORS.length]}" vector-effect="non-scaling-stroke"/>`).join("")}</svg>`;
}

function fitView(parts: PrimitiveEditor[]): ViewBounds {
  if (!parts.length) return { minX: -7, minY: -5, width: 14, height: 10 };
  const translations = resolveEditorTranslations(parts); const points = parts.flatMap((part) => shapePoints(primitiveShape(part)).map((point) => transformPoint(point, part.rotation, translations.get(part.id)!.x, translations.get(part.id)!.y)));
  const bounds = boundsOf(points); const width = Math.max(bounds.width * 1.8, 14), height = Math.max(bounds.height * 2, 10); const centerX = (bounds.minX + bounds.maxX) / 2, centerY = (bounds.minY + bounds.maxY) / 2;
  return { minX: centerX - width / 2, minY: centerY - height / 2, width, height };
}

function boundsOf(points: Point[]) { const xs = points.map((point) => point.x), ys = points.map((point) => point.y); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys); return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }; }
function gridLines(view: ViewBounds): string { const step = 1, lines: string[] = []; for (let x = Math.floor(view.minX); x <= view.minX + view.width; x += step) lines.push(`<line class="model-grid" x1="${x}" y1="${-view.minY - view.height}" x2="${x}" y2="${-view.minY}"/>`); for (let y = Math.floor(view.minY); y <= view.minY + view.height; y += step) lines.push(`<line class="model-grid" x1="${view.minX}" y1="${-y}" x2="${view.minX + view.width}" y2="${-y}"/>`); return lines.join(""); }
function studyValues(start: number, end: number, step: number): number[] { const values = [start]; if (step > 0) for (let value = start + step; value < end && values.length < 6; value += step) values.push(value); if (end !== start) values.push(end); return values; }
function modelParameterOptions(item: EditorItem): Array<[string, string]> { const values: Array<[string, string]> = [[`item_scale:${item.id}`, "Whole item scale"]]; item.parts.forEach((part, index) => { values.push([`part_scale:${item.id}:${index}`, `${part.id} · scale`]); if (part.kind === "rectangle" || part.kind === "triangle" || part.kind === "polygon" || part.kind === "bezier") values.push([`part_width:${item.id}:${index}`, `${part.id} · width/base`], [`part_height:${item.id}:${index}`, `${part.id} · height`]); if (part.kind === "circle") values.push([`part_radius:${item.id}:${index}`, `${part.id} · radius`]); }); return values; }
function anchorOptions(selected: AnchorName): string { return ANCHORS.map((anchor) => `<option value="${anchor}" ${anchor === selected ? "selected" : ""}>${anchor.replaceAll("_", " ")}</option>`).join(""); }
function modelNumber(label: string, field: string, value: number, step = .1, disabled = false): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-model-field="${field}" ${disabled ? "disabled" : ""}></label>`; }
function studyNumber(label: string, field: string, value: number): string { return `<label>${label}<input type="number" value="${value}" step=".1" data-model-study="${field}"></label>`; }
function setField(target: object, field: string, value: unknown): void { (target as Record<string, unknown>)[field] = value; }
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, ""); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!); }
