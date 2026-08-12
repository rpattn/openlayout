import { isPartSelection, type CadSelection } from "./cad-selection";
import { ANCHORS, editorColor } from "./design-tokens";
import { primitiveDependsOn } from "./problem";
import type { EditorState, Placement, PrimitiveEditor } from "./types";
import { escapeHtml, formatNumber } from "./ui-utils";

export interface InspectorContext {
  state: EditorState;
  selection: CadSelection | null;
  selections: CadSelection[];
  selectedPartIndex: number;
  placements?: Placement[];
  isLocked(selection: CadSelection): boolean;
  selectionLabel(selection: CadSelection): string;
  partOwnerOptions: string;
}

export interface InspectorMarkup {
  html: string;
  selectedPartIndex: number;
}

export function renderInspector(context: InspectorContext): InspectorMarkup {
  const { state, selection, selections } = context;
  let partIndex = context.selectedPartIndex;
  const result = (html: string): InspectorMarkup => ({ html, selectedPartIndex: partIndex });
  if (selection && context.isLocked(selection)) return result(`<div class="inspector-heading"><div><small>LOCKED ENTITY</small><h2>${escapeHtml(context.selectionLabel(selection))}</h2></div><span class="selection-badge">Locked</span></div><button data-toggle-lock class="button full">Unlock</button>`);
  if (selections.length > 1) return result(`<div class="inspector-empty"><small>MULTI-SELECTION</small><strong>${selections.length} ${selections.every(isPartSelection) ? "parts" : "objects"} selected</strong></div>`);
  if (!selection) return result('<div class="inspector-empty"><small>INSPECTOR</small><strong>Nothing selected</strong></div>');

  if (selection.kind === "guide") {
    const guide = state.drafting.guides[selection.index];
    return result(guide ? `<div class="inspector-heading"><div><small>DRAFTING GUIDE</small><h2>Construction line ${selection.index + 1}</h2></div><span class="selection-badge">${format(guide.rotation)}°</span></div><button data-delete-object class="button danger full">Delete line</button>` : emptyConstruction("Guide unavailable"));
  }
  if (selection.kind === "drafting") {
    const shape = state.drafting.shapes[selection.index];
    return result(shape ? `<div class="inspector-heading"><div><small>DRAFTING SHAPE</small><h2>${shape.closed ? "Construction shape" : "Construction path"} ${selection.index + 1}</h2></div><span class="selection-badge">${shape.points.length} points</span></div><p class="hint">Grid snap · Alt bypass</p><button data-delete-object class="button danger full">Delete drafting shape</button>` : emptyConstruction("Drafting shape unavailable"));
  }
  if (selection.kind === "dimension") {
    const dimension = state.dimensions[selection.index];
    if (!dimension) return result(emptyConstruction("Dimension unavailable"));
    const measured = Math.hypot(dimension.end.x - dimension.start.x, dimension.end.y - dimension.start.y);
    return result(`<div class="inspector-heading"><div><small>ENGINEERING DIMENSION</small><h2>Dimension ${selection.index + 1}</h2></div><span class="selection-badge">${format(measured)}</span></div>
      <div class="field-grid two">${numberField("Start X", "data-dimension-field", "start.x", dimension.start.x)}${numberField("Start Y", "data-dimension-field", "start.y", dimension.start.y)}${numberField("End X", "data-dimension-field", "end.x", dimension.end.x)}${numberField("End Y", "data-dimension-field", "end.y", dimension.end.y)}${numberField("Offset X", "data-dimension-field", "offset.x", dimension.offset.x)}${numberField("Offset Y", "data-dimension-field", "offset.y", dimension.offset.y)}<label class="wide">Text override<input data-dimension-field="textOverride" value="${escapeHtml(dimension.textOverride)}" placeholder="Calculated value"></label></div><p class="hint">Drag the dimension line or text to reposition it.</p><button data-delete-object class="button danger full">Delete dimension</button>`);
  }
  if (selection.kind === "auto-dimension") {
    const position = state.dimensionPositions[selection.owner] ?? { x: 0, y: 0 }, key = `${selection.owner}:${selection.axis}`;
    return result(`<div class="inspector-heading"><div><small>GENERATED DIMENSION</small><h2>${escapeHtml(selection.owner)}</h2></div><span class="selection-badge">${escapeHtml(selection.axis)}</span></div><div class="field-grid two">${numberField("Offset X", "data-auto-dimension-field", "x", position.x)}${numberField("Offset Y", "data-auto-dimension-field", "y", position.y)}<label class="wide">Text override<input data-auto-dimension-field="override" value="${escapeHtml(state.dimensionOverrides[key] ?? "")}" placeholder="Calculated value"></label></div><p class="hint">Drag the line or label to move it · Alt bypasses grid snap.</p><button data-reset-auto-dimension class="button ghost full">Reset generated dimension</button>`);
  }
  if (selection.kind === "trace") {
    const trace = state.drafting.traceImages[selection.index];
    return result(trace ? `<div class="inspector-heading"><div><small>TRACE IMAGE</small><h2>Reference image ${selection.index + 1}</h2></div><span class="selection-badge">${format(trace.opacity * 100)}%</span></div><button data-delete-object class="button danger full">Remove image</button>` : emptyConstruction("Trace image unavailable"));
  }
  if (selection.kind === "text") {
    const entry = state.drafting.texts[selection.index];
    if (!entry) return result(emptyConstruction("Text unavailable"));
    return result(`<div class="inspector-heading"><div><small>SCENE TEXT</small><h2>Text ${selection.index + 1}</h2></div><span class="selection-badge">Drafting aid</span></div><div class="field-grid two"><label class="wide">Text<textarea rows="4" data-text-field="text">${escapeHtml(entry.text)}</textarea></label>${numberField("X", "data-text-field", "x", entry.x)}${numberField("Y", "data-text-field", "y", entry.y)}${numberField("Size", "data-text-field", "fontSize", entry.fontSize, .25)}${numberField("Rotation°", "data-text-field", "rotation", entry.rotation, 1)}<label>Font<select data-text-field="fontFamily">${options(["mono", "sans", "serif"], ["Monospace", "Sans serif", "Serif"], entry.fontFamily)}</select></label><label>Alignment<select data-text-field="align">${options(["left", "center", "right"], ["Left", "Centre", "Right"], entry.align)}</select></label><label class="checkbox-field"><input type="checkbox" data-text-field="bold" ${entry.bold ? "checked" : ""}> Bold</label><label class="checkbox-field"><input type="checkbox" data-text-field="italic" ${entry.italic ? "checked" : ""}> Italic</label><label class="checkbox-field wide"><input type="checkbox" data-text-field="underline" ${entry.underline ? "checked" : ""}> Underline</label><label class="wide">Colour<input type="color" data-text-field="color" value="${escapeHtml(entry.color)}"></label></div><p class="hint">Drag to move · use the corner and top handles to resize and rotate.</p><button data-delete-object class="button danger full">Delete text</button>`);
  }
  if (selection.kind === "placement") {
    const placement = context.placements?.[selection.index];
    if (!placement) return result('<div class="inspector-empty"><strong>Placement unavailable</strong></div>');
    return result(`<div class="inspector-heading"><div><small>PACKED ITEM ${selection.index + 1}</small><h2>${escapeHtml(placement.item_id)}</h2></div><span class="selection-badge">Manual edit</span></div><div class="field-grid three">${numberField("X", "data-placement-field", "x", placement.x)}${numberField("Y", "data-placement-field", "y", placement.y)}${numberField("Rotation°", "data-placement-field", "rotation_deg", placement.rotation_deg, 1)}</div><p class="hint">Manual layout · validation stale</p><button id="reset-layout" class="button ghost full">Discard solved layout</button>`);
  }
  if (selection.kind === "container") {
    const entry = state.containerParts[selection.index];
    if (!entry) return result(emptyConstruction("Container is empty", "Add material or a cut-out from the object bar."));
    return result(`<div class="inspector-heading"><div><small>CONTAINER REGION</small><h2>${escapeHtml(entry.id)}</h2></div><span class="selection-badge">${entry.operation}</span></div><div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(entry.id)}"></label><label>Boolean operation<select data-object-field="operation">${options(["add", "subtract"], ["Add material", "Subtract cut-out"], entry.operation)}</select></label></div>${primitiveEditor(entry.primitive, context.partOwnerOptions)}${snapEditor(state.containerParts.map((region) => region.primitive), entry.primitive, "REGION CONNECTION")}<button data-delete-object class="button danger full">Delete region</button>`);
  }
  if (selection.kind === "exclusion") {
    const entry = state.exclusions[selection.index];
    if (!entry) return result(emptyConstruction("Exclusion unavailable", "Select or add an exclusion."));
    partIndex = normalizePartIndex(partIndex, entry.parts);
    const part = entry.parts[partIndex];
    return result(`<div class="inspector-heading"><div><small>EXCLUSION</small><h2>${escapeHtml(entry.id)}</h2></div><span class="selection-badge">${format(entry.clearance)} clear</span></div><div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(entry.id)}"></label>${numberField("Clearance", "data-object-field", "clearance", entry.clearance, .05)}</div>${constructionEditor(entry.parts, part, partIndex, "EXCLUSION PART", context.partOwnerOptions)}<div class="inline-actions"><button data-delete-part class="button danger" ${part ? "" : "disabled"}>Delete part</button><button data-delete-object class="button danger">Delete exclusion</button></div>`);
  }
  const item = state.items[selection.index];
  if (!item) return result(emptyConstruction("Shape unavailable", "Select or add a packable shape."));
  partIndex = normalizePartIndex(partIndex, item.parts);
  const part = item.parts[partIndex];
  const rotationFields = item.rotationMode === "continuous" ? numberField("Minimum°", "data-object-field", "minRotation", item.minRotation, 1) + numberField("Maximum°", "data-object-field", "maxRotation", item.maxRotation, 1) : `<label class="wide">Angles<input data-object-field="rotations" value="${escapeHtml(item.rotations)}"></label>`;
  return result(`<div class="inspector-heading"><div><small>PACKABLE SHAPE</small><h2>${escapeHtml(item.id)}</h2></div><span class="selection-badge">${item.quantity} requested</span></div><div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(item.id)}"></label><label>Quantity<input type="number" step="1" data-object-field="quantity" value="${item.quantity}"></label><label>Rotation search<select data-object-field="rotationMode">${options(["continuous", "discrete"], ["Adaptive", "Fixed angles"], item.rotationMode)}</select></label><label>Coupling<select data-object-field="rotationCoupling">${options(["independent", "shared_per_item"], ["Independent", "Shared"], item.rotationCoupling)}</select></label>${rotationFields}</div>${constructionEditor(item.parts, part, partIndex, "PART CONSTRAINT", context.partOwnerOptions)}<div class="inline-actions"><button data-delete-part class="button danger" ${part ? "" : "disabled"}>Delete part</button><button data-delete-object class="button danger">Delete item</button></div>`);
}

function constructionEditor(parts: PrimitiveEditor[], part: PrimitiveEditor | undefined, partIndex: number, snapTitle: string, ownerOptions: string): string {
  return `<div class="inline-part-heading"><label>Editing part<select id="item-part-select" ${part ? "" : "disabled"}>${parts.map((entry, index) => `<option value="${index}" ${index === partIndex ? "selected" : ""}>${escapeHtml(entry.id)} · ${entry.kind}</option>`).join("")}</select></label><span>${part ? `${partIndex + 1}/${parts.length}` : "0/0"}</span></div>${part ? primitiveEditor(part, ownerOptions) + snapEditor(parts, part, snapTitle) : '<div class="inspector-empty compact"><strong>Empty construction</strong></div>'}<div class="part-add-row">${(["rectangle", "triangle", "circle", "polygon", "bezier"] as const).map((kind) => `<button data-add-part="${kind}">+ ${kind}</button>`).join("")}</div>`;
}

function primitiveEditor(part: PrimitiveEditor, ownerOptions: string): string {
  const field = (label: string, name: string, value: number, step = .1) => numberField(label, "data-primitive-field", name, value, step);
  const dimensions = part.kind === "rectangle" ? field("Width", "width", part.width) + field("Height", "height", part.height)
    : part.kind === "triangle" ? field("Base", "base", part.base) + field("Height", "height", part.height)
      : part.kind === "circle" ? field("Radius", "radius", part.radius) + field("Segments", "segments", part.segments, 1)
        : part.kind === "polygon" ? `<label class="wide">Vertices<textarea rows="4" data-primitive-points>${part.vertices.map((point) => `${format(point.x)}, ${format(point.y)}`).join("\n")}</textarea></label>`
          : `${field("Curve segments", "segments", part.segments, 1)}<label class="wide">Bézier knots<textarea rows="5" data-bezier-knots>${escapeHtml(JSON.stringify(part.knots, null, 2))}</textarea></label><div class="inline-actions wide"><button type="button" data-mirror-bezier="x" class="button ghost">Mirror left ↔ right</button><button type="button" data-mirror-bezier="y" class="button ghost">Mirror top ↔ bottom</button></div>`;
  return `<div class="primitive-editor"><div class="primitive-editor-title"><small>PART GEOMETRY</small><span>${escapeHtml(part.id)}${part.snap ? " · snapped" : ""}</span></div><div class="field-grid two"><label class="wide">Shape type<select data-primitive-kind>${options(["rectangle", "triangle", "circle", "polygon", "bezier"], ["Rectangle", "Triangle", "Circle", "Polygon", "Bézier"], part.kind)}</select></label>${dimensions}${field("X", "x", part.x)}${field("Y", "y", part.y)}${field("Rotation°", "rotation", part.rotation, 1)}<label>Colour<input type="color" data-primitive-color value="${editorColor(part)}"></label><label class="wide">Construction<select data-part-owner>${ownerOptions}</select></label></div></div>`;
}

function snapEditor(parts: PrimitiveEditor[], part: PrimitiveEditor, title: string): string {
  const targets = parts.filter((entry) => entry.id !== part.id && !primitiveDependsOn(parts, entry.id, part.id));
  return `<div class="inline-snap"><div class="primitive-editor-title"><small>${title}</small><span>${part.snap ? "Anchored" : "Free"}</span></div><label>Snap to<select data-snap-target><option value="">Free position</option>${targets.map((target) => `<option value="${escapeHtml(target.id)}" ${part.snap?.targetId === target.id ? "selected" : ""}>${escapeHtml(target.id)}</option>`).join("")}</select></label>${part.snap ? `<div class="field-grid two"><label>Own anchor<select data-snap-anchor="ownAnchor">${anchorOptions(part.snap.ownAnchor)}</select></label><label>Target anchor<select data-snap-anchor="targetAnchor">${anchorOptions(part.snap.targetAnchor)}</select></label>${numberField("Offset X", "data-snap-offset", "x", part.snap.offset.x)}${numberField("Offset Y", "data-snap-offset", "y", part.snap.offset.y)}</div><button id="detach-inline-snap" class="button ghost full">Detach at current position</button>` : ""}</div>`;
}

function numberField(label: string, attribute: string, field: string, value: number, step = .1): string {
  return `<label>${label}<input type="number" value="${format(value)}" step="${step}" ${attribute}="${field}"></label>`;
}

function options(values: readonly string[], labels: readonly string[], selected: string): string {
  return values.map((value, index) => `<option value="${value}" ${value === selected ? "selected" : ""}>${labels[index]}</option>`).join("");
}

function anchorOptions(selected: string): string {
  return ANCHORS.map((anchor) => `<option value="${anchor}" ${anchor === selected ? "selected" : ""}>${anchor.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}</option>`).join("");
}

function normalizePartIndex(index: number, parts: PrimitiveEditor[]): number {
  return Math.min(index, Math.max(0, parts.length - 1));
}

function emptyConstruction(title: string, message = ""): string {
  return `<div class="inspector-empty"><small>INSPECTOR</small><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>`;
}

function format(value: number): string {
  return formatNumber(value);
}
