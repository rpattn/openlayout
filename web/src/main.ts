import "./style.css";
import { CadWorkspace } from "./cad-workspace";
import { cadLockReference, isPartSelection, sameCadSelection as sameSelection, type CadSelection } from "./cad-selection";
import { initGeometryResolver } from "./geometry-resolver";
import { SolverClient } from "./solver-client";
import { fromProblem, makePrimitive, parsePointText, primitiveDependsOn, primitiveShape, resolveEditorTranslations, shapePoints, toProblem, transformPoint } from "./problem";
import { renderLayout, renderPolygonsPreview, renderSensitivity, sensitivityValueAt } from "./renderer";
import { resolveGeometry } from "./geometry-resolver";
import { WorkspaceHistory, WorkspaceStore } from "./workspace-store";
import { escapeHtml, formatNumber, humanize } from "./ui-utils";
import { editorColor } from "./design-tokens";
import { downloadBlob, downloadLayoutPng, downloadText, layoutToSvg, placementsCsv, safeFilename, shapesToSvg } from "./export-service";
import { decodeParameter, parameterCatalog, parameterCurrentValue, stateAtParameter, studyValues } from "./sensitivity-model";
import { bindToolbarPalette, closeToolbarPalettes } from "./toolbar-palette";
import { shortcutsMarkup } from "./shortcuts";
import { renderInspector } from "./inspector-markup";
import { studioShellHtml } from "./studio-shell";
import { packingSidebarHtml } from "./packing-sidebar";
import { diagnosticsHtml, metricsHtml, parameterMatchesHtml, sensitivitySidebarHtml, studyStepsHtml, transitionsHtml } from "./sensitivity-markup";
import { exportOptionsHtml, projectDialogHtml } from "./dialog-markup";
import type {
  AnchorName, EditorItem, EditorState, PackingProblem, Placement, Point, PrimitiveEditor, SensitivityProgress,
  SensitivityResult, SensitivityStudy, SolveProgress, SolveResult,
} from "./types";

type PageName = "packing" | "sensitivity";
type StatusTone = "neutral" | "working" | "success" | "error";

await initGeometryResolver();

const root = document.querySelector<HTMLDivElement>("#app")!;
const client = new SolverClient();
const projects = new WorkspaceStore();
await projects.recoverDurable();
void projects.requestPersistentStorage();
const history = new WorkspaceHistory();
let state = structuredClone(projects.active.state);
let page: PageName = "packing";
let currentResult: SolveResult | null = null;
let sensitivityResult: SensitivityResult | null = null;
let sensitivitySelection: number | null = null;
let selection: CadSelection | null = { kind: "container", index: 0 };
let selections: CadSelection[] = selection ? [selection] : [];
let selectedPartIndex = 0;
let itemClipboard: EditorItem[] = [];
interface PartClipboard {
  owner: { kind: "item" | "exclusion"; index: number };
  parts: PrimitiveEditor[];
}
let partClipboard: PartClipboard | null = null;
let placementClipboard: Placement[] = [];
let cad: CadWorkspace;
let running = false;
let manualLayout = false;
let resultStale = false;
let draftingShapeMode = false;
let activeDraftPathTool: "line" | "polyline" | null = null;
let activeGuideRotation: number | null = null;
let activeDimensionTool = false;
const display = { dimensions: state.viewSettings.showDimensions, clearance: state.viewSettings.showClearance };
const studyDisplay = { dimensions: false, clearance: false };

root.innerHTML = studioShellHtml({ defaultOwner: state.drafting.defaultOwner, studyDisplay });
applyTheme(projects.theme);
cad = new CadWorkspace(document.getElementById("cad-canvas") as unknown as SVGSVGElement, state, toProblem(state), {
  onSelect: selectCad,
  onMarquee: selectMarquee,
  onDefinitionChange: definitionChanged,
  onPlacementChange: placementChanged,
  onDraftingPath: (points) => addDraftingPath(points, false),
  onConstructionGuide: placeConstructionGuide,
  onDimensionCreate: addDimension,
  onDimensionChange: dimensionChanged,
  onDimensionPositionChange: automaticDimensionChanged,
  onPlacementRejected: () => setStatus("error", "No feasible position was found near that location"),
  onPlacementAdjusted: () => setStatus("neutral", "Moved to the closest feasible position near the pointer"),
});
bindShell();
syncWorkspaceOverlays();
renderPackingSidebar();
renderDraftingPanel();
renderViewSettingsPanel();
renderSensitivitySidebar();
updateHistoryButtons();

function bindShell(): void {
  element("open-projects").addEventListener("click", openProjects);
  element<HTMLSelectElement>("quick-project").addEventListener("change", (event) => { projects.save(state); loadProject((event.target as HTMLSelectElement).value); });
  element("open-diagnostics").addEventListener("click", () => element<HTMLDialogElement>("diagnostics-dialog").showModal());
  element("open-sensitivity").addEventListener("click", () => showPage("sensitivity"));
  element("back-to-workspace").addEventListener("click", () => showPage("packing"));
  element("edit-study-source").addEventListener("click", editStudySource);
  element("edit-selected-layout").addEventListener("click", editSelectedLayout);
  ["open-export", "open-export-study"].forEach((id) => element(id).addEventListener("click", openExport));
  ["open-shortcuts", "open-shortcuts-study"].forEach((id) => element(id).addEventListener("click", openShortcuts));
  element("sidebar-toggle").addEventListener("click", toggleSidebar);
  element("fit-view").addEventListener("click", () => cad.fit());
  element("focus-selection").addEventListener("click", () => cad.focusSelection());
  element("zoom-in").addEventListener("click", () => cad.zoom(.8));
  element("zoom-out").addEventListener("click", () => cad.zoom(1.25));
  document.querySelectorAll<HTMLButtonElement>("[data-toolbar-shape]").forEach((button) => button.addEventListener("click", () => addGeometry(button.dataset.toolbarShape as PrimitiveEditor["kind"])));
  bindToolbarPalette("toolbar-add-shape", (value) => addGeometry(value as PrimitiveEditor["kind"]));
  bindToolbarPalette("toolbar-default-owner", (value) => {
    const owner = value as EditorState["drafting"]["defaultOwner"];
    mutate(() => { state.drafting.defaultOwner = owner; }, false);
    setStatus("neutral", `Unselected new shapes will become ${owner === "cutout" ? "container cut-outs" : owner + " geometry"}`);
  }, true);
  element<HTMLInputElement>("toolbar-part-color").addEventListener("input", (event) => mutate(() => {
    const color = (event.target as HTMLInputElement).value;
    selectedPrimitivesForColor().forEach((part) => { part.color = color; });
    selectedTextsForColor().forEach((entry) => { entry.color = color; });
  }));
  element("join-material").addEventListener("click", joinSelectedMaterial);
  element("lock-selection").addEventListener("click", toggleSelectionLock);
  element("delete-selection").addEventListener("click", deleteToolbarSelection);
  element("toggle-dimensions").addEventListener("click", () => toggleOverlay("dimensions"));
  element("toggle-clearance").addEventListener("click", () => toggleOverlay("clearance"));
  element("draw-dimension").addEventListener("click", () => toggleDimensionTool());
  element("open-view-settings").addEventListener("click", () => {
    const panel = element<HTMLElement>("view-settings-panel"), opening = panel.hidden;
    closeToolbarPalettes(); closeDraftingPanel(); panel.hidden = !opening;
    const button = element<HTMLButtonElement>("open-view-settings"); button.setAttribute("aria-pressed", String(opening)); button.classList.toggle("active", opening);
    if (opening) renderViewSettingsPanel();
  });
  element("respect-manual-constraints").addEventListener("click", () => {
    const button = element<HTMLButtonElement>("respect-manual-constraints"), enabled = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(enabled)); button.classList.toggle("active", enabled); cad.setRespectFixed(enabled);
    setStatus("neutral", enabled ? "Manual edits will respect boundaries, clearances, overlaps, and fixed placements" : "Constraint checks disabled for manual edits");
  });
  element("open-drafting-aids").addEventListener("click", () => {
    const panel = element<HTMLElement>("drafting-panel"), opening = panel.hidden;
    closeToolbarPalettes(); panel.hidden = !opening;
    element<HTMLButtonElement>("open-drafting-aids").setAttribute("aria-pressed", String(opening));
    element<HTMLButtonElement>("open-drafting-aids").classList.toggle("active", opening);
  });
  element("add-trace-image").addEventListener("click", () => element<HTMLInputElement>("toolbar-trace-image-input").click());
  element("add-scene-text").addEventListener("click", addSceneText);
  element("add-vertical-guide").addEventListener("click", () => setConstructionGuideTool(90));
  element("add-horizontal-guide").addEventListener("click", () => setConstructionGuideTool(0));
  element("draw-drafting-line").addEventListener("click", () => setDraftPathTool("line"));
  element("draw-drafting-polyline").addEventListener("click", () => setDraftPathTool("polyline"));
  element("drafting-shape-mode").addEventListener("click", () => {
    draftingShapeMode = !draftingShapeMode;
    const button = element<HTMLButtonElement>("drafting-shape-mode"); button.classList.toggle("active", draftingShapeMode); button.setAttribute("aria-pressed", String(draftingShapeMode));
    setStatus("neutral", draftingShapeMode ? "Shape buttons now create drafting geometry" : "Shape buttons create problem geometry");
  });
  bindTraceImageInput(element<HTMLInputElement>("toolbar-trace-image-input"));
  element("undo").addEventListener("click", undo);
  element("redo").addEventListener("click", redo);
  element("theme-toggle").addEventListener("click", toggleTheme);
  element("theme-toggle-study").addEventListener("click", toggleTheme);
  element("solve").addEventListener("click", () => void solve());
  element("validate").addEventListener("click", () => void validate());
  element("cancel").addEventListener("click", cancel);
  element("copy-result").addEventListener("click", () => void copyResult());
  const canvas = document.getElementById("cad-canvas") as unknown as SVGSVGElement, contextMenu = element("cad-context-menu");
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const target = (event.target as Element).closest<SVGElement>("[data-cad-kind]");
    if (target) selectCad(target.dataset.cadKind === "auto-dimension"
      ? { kind: "auto-dimension", index: Number(target.dataset.cadIndex), owner: target.dataset.autoDimensionOwner!, axis: target.dataset.autoDimensionAxis as "width" | "height" | "clearance" }
      : { kind: target.dataset.cadKind as CadSelection["kind"], index: Number(target.dataset.cadIndex), ...(target.dataset.cadPart === undefined ? {} : { partIndex: Number(target.dataset.cadPart) }) } as CadSelection, target.dataset.cadPart === undefined ? undefined : Number(target.dataset.cadPart));
    contextMenu.style.left = `${event.clientX}px`; contextMenu.style.top = `${event.clientY}px`; contextMenu.hidden = false;
    const kind = selection?.kind, layered = kind === "text" || kind === "trace" || kind === "drafting" || kind === "dimension";
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="fixed"]')!.hidden = kind !== "placement";
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="copy"]')!.hidden = !(kind === "item" || kind === "placement");
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="duplicate"]')!.hidden = !kind || kind === "auto-dimension" || kind === "container" || kind === "exclusion";
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="front"]')!.hidden = !layered;
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="back"]')!.hidden = !layered;
    const lockButton = contextMenu.querySelector<HTMLButtonElement>('[data-context-action="lock"]')!;
    lockButton.hidden = !selection || kind === "dimension" || kind === "auto-dimension"; lockButton.textContent = selection && isLocked(selection) ? "Unlock" : "Lock";
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="reset-rotation"]')!.hidden = !selection || kind === "dimension" || kind === "auto-dimension";
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="delete"]')!.hidden = kind === "auto-dimension";
  });
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target as Element).closest("#cad-context-menu")) contextMenu.hidden = true;
    if (!(event.target as Element).closest(".tool-popover")) closeToolbarPalettes();
    if (!(event.target as Element).closest("#drafting-panel, #open-drafting-aids")) closeDraftingPanel();
    if (!(event.target as Element).closest("#view-settings-panel, #open-view-settings")) closeViewSettingsPanel();
  });
  contextMenu.querySelectorAll<HTMLButtonElement>("[data-context-action]").forEach((button) => button.addEventListener("click", () => {
    contextMenu.hidden = true;
    if (button.dataset.contextAction === "focus") cad.focusSelection();
    else if (button.dataset.contextAction === "copy") copySelectedItems();
    else if (button.dataset.contextAction === "duplicate") duplicateContextSelection();
    else if (button.dataset.contextAction === "lock") toggleSelectionLock();
    else if (button.dataset.contextAction === "front") reorderContextSelection("front");
    else if (button.dataset.contextAction === "back") reorderContextSelection("back");
    else if (button.dataset.contextAction === "reset-rotation") resetSelectionRotation();
    else if (button.dataset.contextAction === "delete") deleteToolbarSelection();
    else if (selection?.kind === "placement" && currentResult?.placements[selection.index]) { currentResult.placements[selection.index].fixed = !currentResult.placements[selection.index].fixed; placementChanged(selection.index, currentResult.placements[selection.index]); }
  }));
  bindOverlay("study", studyDisplay);
  const chart = element<HTMLCanvasElement>("sensitivity-canvas");
  chart.addEventListener("click", (event) => {
    if (sensitivityResult) selectSensitivityEvaluation(sensitivityValueAt(chart, sensitivityResult, event.clientX), "graph");
  });
  element("sensitivity-scroll").addEventListener("wheel", (event) => {
    const scroll = event.currentTarget as HTMLElement;
    if (scroll.scrollWidth > scroll.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { scroll.scrollLeft += event.deltaY; event.preventDefault(); }
  }, { passive: false });
  window.addEventListener("resize", () => refreshCurrentPage());
  window.addEventListener("keydown", (event) => {
    if (handleShortcut(event)) return;
    if ((event.key === "Delete" || event.key === "Backspace") && !isEditingText(event.target)) {
      event.preventDefault(); deleteToolbarSelection(); return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === "c" && !isEditingText(event.target)) { event.preventDefault(); copySelectedItems(); return; }
    if (event.key.toLowerCase() === "v" && !isEditingText(event.target)) { event.preventDefault(); pasteItems(); return; }
    if (event.key.toLowerCase() === "d" && !isEditingText(event.target)) { event.preventDefault(); copySelectedItems(); pasteItems(); return; }
    if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    if (event.key.toLowerCase() === "s") { event.preventDefault(); projects.save(state); setStatus("success", "Project saved on this device"); }
  });
}

function handleShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  if (key === "escape") {
    element("cad-context-menu").hidden = true;
    if (activeGuideRotation !== null) { setConstructionGuideTool(null); return true; }
    if (activeDraftPathTool) { setDraftPathTool(null); return true; }
    if (activeDimensionTool) { toggleDimensionTool(false); return true; }
    if (closeToolbarPalettes(true)) return true;
    if (!element<HTMLElement>("drafting-panel").hidden) { closeDraftingPanel(); return true; }
    if (!element<HTMLElement>("view-settings-panel").hidden) { closeViewSettingsPanel(); return true; }
    const open = document.querySelector<HTMLDialogElement>("dialog[open]"); if (open) open.close();
    return !!open;
  }
  if (isEditingText(event.target) || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (key === "enter" && activeDraftPathTool === "polyline") { event.preventDefault(); if (cad.finishDraftPath()) clearDraftPathTool(); return true; }
  const act = (action: () => void) => { event.preventDefault(); action(); return true; };
  if (event.key === "?" || (event.key === "/" && event.shiftKey)) return act(openShortcuts);
  if (key === "1") return act(() => showPage("packing"));
  if (key === "2") return act(() => showPage("sensitivity"));
  if (key === "e") return act(openExport);
  if (key === "r") return act(() => void (page === "packing" ? solve() : runStudy()));
  if (key === "v") return act(() => void validate());
  if (page !== "packing") return false;
  if (key === "f") return act(() => event.shiftKey ? cad.focusSelection() : cad.fit());
  if (key === "d") return act(() => toggleOverlay("dimensions"));
  if (key === "g") return act(() => toggleOverlay("clearance"));
  if (key === "p") return act(toggleSidebar);
  if (event.key === "+" || event.key === "=") return act(() => cad.zoom(.8));
  if (event.key === "-" || event.key === "_") return act(() => cad.zoom(1.25));
  return false;
}

function openShortcuts(): void {
  const host = element("shortcut-list");
  host.innerHTML = shortcutsMarkup();
  element<HTMLDialogElement>("shortcuts-dialog").showModal();
}

function toggleTheme(): void { applyTheme(projects.theme === "dark" ? "light" : "dark"); }

function toggleSidebar(): void {
  const hidden = element("cad-shell").classList.toggle("panel-hidden");
  const button = element<HTMLButtonElement>("sidebar-toggle");
  button.setAttribute("aria-label", hidden ? "Show problem panel" : "Hide problem panel");
  button.title = `${hidden ? "Show" : "Hide"} problem panel (P)`;
  requestAnimationFrame(() => cad.fit());
}

function toggleOverlay(key: keyof typeof display): void {
  display[key] = !display[key];
  if (key === "dimensions") state.viewSettings.showDimensions = display[key]; else state.viewSettings.showClearance = display[key];
  projects.save(state);
  const button = element<HTMLButtonElement>(key === "dimensions" ? "toggle-dimensions" : "toggle-clearance");
  button.classList.toggle("active", display[key]);
  button.setAttribute("aria-pressed", String(display[key]));
  cad.setOverlays(display.dimensions, display.clearance);
}

function showPage(next: PageName): void {
  page = next;
  element("packing-page").hidden = next !== "packing";
  element("sensitivity-page").hidden = next !== "sensitivity";
  if (next === "packing") requestAnimationFrame(() => refreshPacking());
  else { renderSensitivitySidebar(); requestAnimationFrame(refreshSensitivityPage); }
}

function selectCad(next: CadSelection | null, partIndex?: number, additive = false): void {
  if (next && (next.kind === "item" || next.kind === "exclusion") && partIndex !== undefined) next = { ...next, partIndex };
  const previous = selection;
  if (additive && next) {
    const existing = selections.findIndex((entry) => sameSelection(entry, next));
    if (existing >= 0) selections.splice(existing, 1); else selections.push(next);
    selection = existing >= 0 ? selections.at(-1) ?? null : next;
  } else {
    selection = next;
    selections = next ? [next] : [];
  }
  if (next?.kind !== previous?.kind || next?.index !== previous?.index) selectedPartIndex = 0;
  if ((next?.kind === "item" || next?.kind === "exclusion") && partIndex !== undefined) selectedPartIndex = partIndex;
  cad.setSelection(selection, selectedPartIndex, selections);
  renderPackingSidebar();
  updateToolbarState();
}

function selectMarquee(next: CadSelection[], additive: boolean): void {
  if (additive) {
    next.forEach((candidate) => {
      if (!selections.some((entry) => sameSelection(entry, candidate))) selections.push(candidate);
    });
  } else selections = next;
  selection = selections.at(-1) ?? null;
  selectedPartIndex = 0;
  cad.setSelection(selection, selectedPartIndex, selections);
  renderPackingSidebar();
}

function renderPackingSidebar(): void {
  const quickProject = element<HTMLSelectElement>("quick-project");
  quickProject.innerHTML = projects.projects.map((project) => `<option value="${project.id}" ${project.id === projects.activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  element("active-project-name").textContent = projects.active.name;
  const sidebar = element("packing-sidebar");
  sidebar.innerHTML = packingSidebarHtml({
    state,
    selection,
    selections,
    lockedSelections: lockedSelections(),
    inspectorHtml: selectionInspector(),
    isLocked,
    selectionLabel,
  });
  applySidebarTooltips(sidebar);
  sidebar.querySelectorAll<HTMLElement>("[data-cad-select]").forEach((node) => node.addEventListener("click", (event) => {
    const next = parseSelection(node.dataset.cadSelect!); selectCad(next, undefined, event.ctrlKey || event.metaKey);
  }));
  sidebar.querySelector("[data-toggle-lock]")?.addEventListener("click", toggleSelectionLock);
  sidebar.querySelectorAll<HTMLButtonElement>("[data-add-object]").forEach((button) => button.addEventListener("click", () => addObject(button.dataset.addObject!)));
  sidebar.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pack-scope]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const target = input.dataset.packScope === "clearance" ? state.clearance : state.options;
    const value = input instanceof HTMLInputElement && input.type === "number" ? Number(input.value)
      : input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
    setField(target, input.dataset.field!, value);
  }, false)));
  sidebar.querySelectorAll<HTMLInputElement>("[data-placement-field]").forEach((input) => input.addEventListener("change", () => {
    if (selection?.kind !== "placement" || !currentResult) return;
    setField(currentResult.placements[selection.index], input.dataset.placementField!, Number(input.value));
    placementChanged(selection.index, currentResult.placements[selection.index]);
  }));
  bindInlineInspector(sidebar);
  bindFixedPlacements(sidebar);
  sidebar.querySelector("#reset-layout")?.addEventListener("click", () => { clearResults(); refreshPacking(true); setStatus("neutral", "Returned to problem definition"); });
  requestAnimationFrame(renderEntityPreviews);
  renderDraftingPanel();
  renderViewSettingsPanel();
  updateToolbarState();
}

function selectionLabel(value: CadSelection): string {
  return value.kind === "container" ? state.containerParts[value.index]?.id ?? "Material"
    : value.kind === "exclusion" ? state.exclusions[value.index]?.id ?? "Exclusion"
    : value.kind === "item" ? state.items[value.index]?.id ?? "Shape"
    : value.kind === "guide" ? `Construction line ${value.index + 1}`
    : value.kind === "drafting" ? `${state.drafting.shapes[value.index]?.closed ? "Construction shape" : "Construction path"} ${value.index + 1}`
    : value.kind === "dimension" ? `Dimension ${value.index + 1}`
    : value.kind === "auto-dimension" ? `${value.owner} ${value.axis}`
    : value.kind === "text" ? `Text ${value.index + 1}`
    : value.kind === "trace" ? `Reference image ${value.index + 1}` : currentResult?.placements[value.index]?.item_id ?? "Packed item";
}

function selectionForLock(ref: EditorState["lockedEntities"][number]): CadSelection | null {
  const index = ref.kind === "container" ? state.containerParts.findIndex((entry) => entry.id === ref.id)
    : ref.kind === "exclusion" ? state.exclusions.findIndex((entry) => entry.id === ref.id)
    : ref.kind === "item" ? state.items.findIndex((entry) => entry.id === ref.id)
    : ref.kind === "guide" ? state.drafting.guides.findIndex((entry) => entry.id === ref.id)
    : ref.kind === "drafting" ? state.drafting.shapes.findIndex((entry) => entry.id === ref.id)
    : ref.kind === "text" ? state.drafting.texts.findIndex((entry) => entry.id === ref.id)
    : state.drafting.traceImages.findIndex((entry) => entry.id === ref.id);
  return index >= 0 ? { kind: ref.kind, index } as CadSelection : null;
}

function lockedSelections(): CadSelection[] { return state.lockedEntities.map(selectionForLock).filter((entry): entry is CadSelection => entry !== null); }
function isLocked(value: CadSelection): boolean {
  const ref = cadLockReference(state, value, currentResult?.placements);
  return !!ref && state.lockedEntities.some((entry) => entry.kind === ref.kind && entry.id === ref.id);
}

function toggleSelectionLock(): void {
  if (!selection) return;
  const before = structuredClone(state), unlocking = selections.length === 1 && isLocked(selection);
  if (unlocking) {
    const ref = cadLockReference(state, selection, currentResult?.placements);
    if (ref) state.lockedEntities = state.lockedEntities.filter((entry) => entry.kind !== ref.kind || entry.id !== ref.id);
  } else {
    const refs = selections.map((entry) => cadLockReference(state, entry, currentResult?.placements)).filter((entry): entry is EditorState["lockedEntities"][number] => entry !== null);
    refs.forEach((ref) => { if (!state.lockedEntities.some((entry) => entry.kind === ref.kind && entry.id === ref.id)) state.lockedEntities.push(ref); });
    selection = refs.length ? selectionForLock(refs.at(-1)!) : selection; selections = selection ? [selection] : [];
  }
  history.commit(before, state); projects.save(state); updateHistoryButtons();
  cad.setSelection(selection, selectedPartIndex, selections); renderPackingSidebar(); refreshPacking();
  setStatus("neutral", unlocking ? "Entity unlocked for CAD interaction" : "Selection locked against CAD interaction");
}

function selectionInspector(): string {
  const rendered = renderInspector({
    state,
    selection,
    selections,
    selectedPartIndex,
    placements: currentResult?.placements,
    isLocked,
    selectionLabel,
    partOwnerOptions: partOwnerOptions(),
  });
  selectedPartIndex = rendered.selectedPartIndex;
  return rendered.html;
}

function bindInlineInspector(sidebar: HTMLElement): void {
  sidebar.querySelectorAll<HTMLInputElement>("[data-auto-dimension-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    if (selection?.kind !== "auto-dimension") return;
    const field = input.dataset.autoDimensionField!;
    if (field === "override") state.dimensionOverrides[`${selection.owner}:${selection.axis}`] = input.value;
    else { const position = state.dimensionPositions[selection.owner] ?? { x: 0, y: 0 }; position[field as "x" | "y"] = Number(input.value); state.dimensionPositions[selection.owner] = position; }
  })));
  sidebar.querySelector("[data-reset-auto-dimension]")?.addEventListener("click", () => mutate(() => {
    if (selection?.kind !== "auto-dimension") return;
    delete state.dimensionOverrides[`${selection.owner}:${selection.axis}`]; delete state.dimensionPositions[selection.owner];
  }));
  sidebar.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-text-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    if (selection?.kind !== "text") return;
    const entry = state.drafting.texts[selection.index]; if (!entry) return;
    const field = input.dataset.textField!;
    if (field === "text" || field === "color" || field === "fontFamily" || field === "align") setField(entry, field, input.value);
    else if (field === "bold" || field === "italic" || field === "underline") setField(entry, field, (input as HTMLInputElement).checked);
    else setField(entry, field, field === "fontSize" ? Math.max(.05, Number(input.value)) : Number(input.value));
  })));
  sidebar.querySelectorAll<HTMLInputElement>("[data-dimension-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    if (selection?.kind !== "dimension") return;
    const dimension = state.dimensions[selection.index]; if (!dimension) return;
    const field = input.dataset.dimensionField!;
    if (field === "textOverride") dimension.textOverride = input.value;
    else { const [owner, key] = field.split(".") as ["start" | "end" | "offset", "x" | "y"]; dimension[owner][key] = Number(input.value); }
  })));
  sidebar.querySelector<HTMLSelectElement>("#item-part-select")?.addEventListener("change", (event) => {
    selectedPartIndex = Number((event.target as HTMLSelectElement).value); cad.setSelection(selection, selectedPartIndex, selections); renderPackingSidebar();
  });
  sidebar.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-object-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const target = selectedObject(); if (!target) return;
    setField(target, input.dataset.objectField!, input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value);
  })));
  sidebar.querySelectorAll<HTMLInputElement>("[data-primitive-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const part = selectedPrimitive(); if (part) setField(part, input.dataset.primitiveField!, Number(input.value));
  })));
  sidebar.querySelector<HTMLSelectElement>("[data-primitive-kind]")?.addEventListener("change", (event) => mutate(() => {
    const part = selectedPrimitive(); if (!part) return;
    replaceSelectedPrimitive(convertPrimitive(part, (event.target as HTMLSelectElement).value as PrimitiveEditor["kind"]));
  }));
  sidebar.querySelector<HTMLInputElement>("[data-primitive-color]")?.addEventListener("input", (event) => mutate(() => {
    const part = selectedPrimitive(); if (part) part.color = (event.target as HTMLInputElement).value;
  }));
  sidebar.querySelector<HTMLSelectElement>("[data-part-owner]")?.addEventListener("change", (event) => moveSelectedPart((event.target as HTMLSelectElement).value));
  sidebar.querySelector<HTMLTextAreaElement>("[data-primitive-points]")?.addEventListener("change", (event) => mutate(() => {
    const part = selectedPrimitive(); if (part?.kind === "polygon") part.vertices = parsePointText((event.target as HTMLTextAreaElement).value);
  }));
  sidebar.querySelector<HTMLTextAreaElement>("[data-bezier-knots]")?.addEventListener("change", (event) => mutate(() => {
    const part = selectedPrimitive(); if (part?.kind === "bezier") part.knots = JSON.parse((event.target as HTMLTextAreaElement).value) as typeof part.knots;
  }));
  sidebar.querySelectorAll<HTMLButtonElement>("[data-mirror-bezier]").forEach((button) => button.addEventListener("click", () => mutate(() => {
    const part = selectedPrimitive(); if (part?.kind !== "bezier") return;
    const axis = button.dataset.mirrorBezier as "x" | "y";
    part.knots = part.knots.map((knot) => ({
      point: mirrorPoint(knot.point, axis), control_in: mirrorPoint(knot.control_in, axis), control_out: mirrorPoint(knot.control_out, axis),
    })).reverse().map((knot) => ({ ...knot, control_in: knot.control_out, control_out: knot.control_in }));
  })));
  sidebar.querySelectorAll<HTMLInputElement>("[data-snap-offset]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const part = selectedPrimitive(); if (part?.snap) part.snap.offset[input.dataset.snapOffset as "x" | "y"] = Number(input.value);
  })));
  sidebar.querySelector<HTMLSelectElement>("[data-snap-target]")?.addEventListener("change", (event) => mutate(() => {
    const parts = selectedConstraintParts(), part = selectedPrimitive(); if (!parts || !part) return;
    const current = resolveEditorTranslations(parts).get(part.id) ?? { x: part.x, y: part.y };
    const targetId = (event.target as HTMLSelectElement).value;
    if (!targetId) { part.x = current.x; part.y = current.y; delete part.snap; return; }
    part.snap = { targetId, ownAnchor: part.snap?.ownAnchor ?? "center", targetAnchor: part.snap?.targetAnchor ?? "center", offset: { x: 0, y: 0 } };
    const snapped = resolveEditorTranslations(parts).get(part.id) ?? current;
    part.snap.offset = { x: current.x - snapped.x, y: current.y - snapped.y };
  }));
  sidebar.querySelectorAll<HTMLSelectElement>("[data-snap-anchor]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const part = selectedPrimitive(); if (part?.snap) part.snap[input.dataset.snapAnchor as "ownAnchor" | "targetAnchor"] = input.value as AnchorName;
  })));
  sidebar.querySelector("#detach-inline-snap")?.addEventListener("click", () => mutate(() => {
    const parts = selectedConstraintParts(), part = selectedPrimitive(); if (!parts || !part) return;
    const position = resolveEditorTranslations(parts).get(part.id) ?? { x: part.x, y: part.y };
    part.x = position.x; part.y = position.y; delete part.snap;
  }));
  sidebar.querySelectorAll<HTMLButtonElement>("[data-add-part]").forEach((button) => button.addEventListener("click", () => mutate(() => {
    const parts = selectedConstraintParts(); if (!parts) return;
    const part = makePrimitive(button.dataset.addPart as PrimitiveEditor["kind"]), target = parts[selectedPartIndex] ?? parts[0];
    if (target) part.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
    parts.push(part); selectedPartIndex = parts.length - 1;
    if (selection?.kind === "item" || selection?.kind === "exclusion") {
      selection = { ...selection, partIndex: selectedPartIndex }; selections = [selection];
    }
  })));
  sidebar.querySelector("[data-delete-part]")?.addEventListener("click", () => mutate(() => {
    deleteSelectedPart();
  }));
  sidebar.querySelector("[data-delete-object]")?.addEventListener("click", deleteSelectedObject);
}

function renderDraftingPanel(): void {
  const panel = element<HTMLElement>("drafting-panel"), hidden = panel.hidden;
  panel.innerHTML = `<header><div><small>CAD SETUP</small><strong>Drafting aids</strong></div><button type="button" data-close-drafting aria-label="Close drafting aids">×</button></header>
    <div class="cad-tool-panel-body">
      <div class="field-grid two"><label>Unit grid<input type="number" min=".001" step=".05" data-drafting-field="gridStep" value="${format(state.drafting.gridStep)}"></label><label class="checkbox-field"><input type="checkbox" data-drafting-field="snapToGrid" ${state.drafting.snapToGrid ? "checked" : ""}> Snap to grid</label><label class="checkbox-field wide"><input type="checkbox" data-drafting-field="smartSnap" ${state.drafting.smartSnap ? "checked" : ""}> Smart size & alignment snap</label></div>
      <div class="primitive-editor-title"><small>CONSTRUCTION LINES</small><span>${state.drafting.guides.length}</span></div>
      <div class="guide-add-row"><button data-add-guide="90" class="${activeGuideRotation === 90 ? "active" : ""}">+ Vertical</button><button data-add-guide="0" class="${activeGuideRotation === 0 ? "active" : ""}">+ Horizontal</button></div>
      ${state.drafting.guides.map((guide, index) => isLocked({ kind: "guide", index }) ? "" : `<div class="drafting-entity-card"><div class="field-grid three">${draftingEntityNumber("X", "guide", index, "x", guide.x)}${draftingEntityNumber("Y", "guide", index, "y", guide.y)}${draftingEntityNumber("Angle°", "guide", index, "rotation", guide.rotation, 1)}</div><button data-delete-guide="${index}" class="text-button danger-text">Delete line</button></div>`).join("") || '<p class="hint">No guides</p>'}
      <div class="primitive-editor-title trace-heading"><small>TRACE IMAGES</small><span>${state.drafting.traceImages.length}</span></div>
      <button type="button" data-choose-trace class="button ghost full">Choose another image…</button>
      ${state.drafting.traceImages.map((trace, index) => isLocked({ kind: "trace", index }) ? "" : `<div class="drafting-entity-card"><div class="field-grid three trace-fields">${draftingEntityNumber("X", "trace", index, "x", trace.x)}${draftingEntityNumber("Y", "trace", index, "y", trace.y)}${draftingEntityNumber("Width", "trace", index, "width", trace.width)}${draftingEntityNumber("Height", "trace", index, "height", trace.height)}${draftingEntityNumber("Angle°", "trace", index, "rotation", trace.rotation, 1)}${draftingEntityNumber("Opacity", "trace", index, "opacity", trace.opacity, .05)}</div><button data-remove-trace="${index}" class="text-button danger-text">Remove image</button></div>`).join("") || '<p class="hint">No images</p>'}
    </div>`;
  panel.hidden = hidden;
  panel.querySelector("[data-close-drafting]")?.addEventListener("click", closeDraftingPanel);
  panel.querySelector("[data-choose-trace]")?.addEventListener("click", () => element<HTMLInputElement>("toolbar-trace-image-input").click());
  bindDraftingControls(panel);
}

function closeDraftingPanel(): void {
  const panel = element<HTMLElement>("drafting-panel"); panel.hidden = true;
  const button = element<HTMLButtonElement>("open-drafting-aids"); button.setAttribute("aria-pressed", "false"); button.classList.remove("active");
}

function renderViewSettingsPanel(): void {
  const panel = element<HTMLElement>("view-settings-panel"), hidden = panel.hidden, view = state.viewSettings;
  panel.innerHTML = `<header><div><small>DISPLAY</small><strong>View settings</strong></div><button type="button" data-close-view-settings aria-label="Close view settings">×</button></header>
    <div class="cad-tool-panel-body">
      <div class="view-settings-group"><div class="primitive-editor-title"><small>OVERLAYS</small><span>Canvas</span></div>
        <div class="field-grid two"><label class="checkbox-field"><input type="checkbox" data-view-overlay="dimensions" ${display.dimensions ? "checked" : ""}> Dimensions</label><label class="checkbox-field"><input type="checkbox" data-view-field="showGrid" ${view.showGrid ? "checked" : ""}> Grid</label><label class="wide">Grid spacing<input type="number" min=".001" step=".05" data-view-field="gridStep" value="${format(state.drafting.gridStep)}"></label></div>
      </div>
      <div class="view-settings-group"><div class="primitive-editor-title"><small>ENGINEERING DIMENSIONS</small><span>Annotation</span></div>
        <div class="field-grid two"><label>Text size px<input type="number" min="7" max="28" step="1" data-view-field="dimensionTextSize" value="${view.dimensionTextSize}"></label><label>Decimals<input type="number" min="0" max="5" step="1" data-view-field="dimensionPrecision" value="${view.dimensionPrecision}"></label><label class="wide">Units<select data-view-field="dimensionUnit"><option value="" ${view.dimensionUnit === "" ? "selected" : ""}>No unit</option>${["mm", "cm", "m", "in"].map((unit) => `<option value="${unit}" ${view.dimensionUnit === unit ? "selected" : ""}>${unit}</option>`).join("")}</select></label></div>
      </div>
      <div class="view-settings-group"><div class="primitive-editor-title"><small>GEOMETRY</small><span>Linework</span></div>
        <label>Edge thickness px<input type="number" min=".5" max="5" step=".1" data-view-field="edgeThickness" value="${view.edgeThickness}"></label>
      </div>
    </div>`;
  panel.hidden = hidden;
  panel.querySelector("[data-close-view-settings]")?.addEventListener("click", closeViewSettingsPanel);
  panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-view-field]").forEach((input) => input.addEventListener("change", () => {
    const before = structuredClone(state), key = input.dataset.viewField!;
    if (key === "gridStep") state.drafting.gridStep = Math.max(.001, Number(input.value) || .5);
    else if (key === "showGrid") state.viewSettings.showGrid = (input as HTMLInputElement).checked;
    else if (key === "dimensionTextSize") state.viewSettings.dimensionTextSize = clampNumber(Number(input.value), 7, 28);
    else if (key === "edgeThickness") state.viewSettings.edgeThickness = clampNumber(Number(input.value), .5, 5);
    else if (key === "dimensionPrecision") state.viewSettings.dimensionPrecision = Math.round(clampNumber(Number(input.value), 0, 5));
    else if (key === "dimensionUnit") state.viewSettings.dimensionUnit = input.value;
    history.commit(before, state); projects.save(state); updateHistoryButtons(); refreshPacking(); renderDraftingPanel(); renderViewSettingsPanel();
    setStatus("neutral", "View settings saved");
  }));
  panel.querySelector<HTMLInputElement>("[data-view-overlay]")?.addEventListener("change", (event) => {
    display.dimensions = (event.target as HTMLInputElement).checked;
    state.viewSettings.showDimensions = display.dimensions; projects.save(state);
    const button = element<HTMLButtonElement>("toggle-dimensions"); button.classList.toggle("active", display.dimensions); button.setAttribute("aria-pressed", String(display.dimensions));
    cad.setOverlays(display.dimensions, display.clearance);
  });
}

function closeViewSettingsPanel(): void {
  const panel = element<HTMLElement>("view-settings-panel"); panel.hidden = true;
  const button = element<HTMLButtonElement>("open-view-settings"); button.setAttribute("aria-pressed", "false"); button.classList.remove("active");
}

function bindDraftingControls(host: HTMLElement): void {
  host.querySelectorAll<HTMLInputElement>("[data-drafting-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const key = input.dataset.draftingField as "gridStep" | "snapToGrid" | "smartSnap";
    if (input.type === "checkbox") state.drafting[key] = input.checked as never;
    else state.drafting.gridStep = Math.max(.001, Number(input.value) || .5);
  })));
  host.querySelectorAll<HTMLButtonElement>("[data-add-guide]").forEach((button) => button.addEventListener("click", () => setConstructionGuideTool(Number(button.dataset.addGuide))));
  host.querySelectorAll<HTMLInputElement>("[data-guide-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const guide = state.drafting.guides[Number(input.dataset.entityIndex)]; if (!guide) return;
    const key = input.dataset.guideField as "x" | "y" | "rotation", value = Number(input.value), step = state.drafting.gridStep;
    guide[key] = roundForEditor(key !== "rotation" && state.drafting.snapToGrid ? Math.round(value / step) * step : value);
  })));
  host.querySelectorAll<HTMLButtonElement>("[data-delete-guide]").forEach((button) => button.addEventListener("click", () => mutate(() => {
    state.drafting.guides.splice(Number(button.dataset.deleteGuide), 1);
  })));
  host.querySelectorAll<HTMLInputElement>("[data-trace-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const trace = state.drafting.traceImages[Number(input.dataset.entityIndex)]; if (!trace) return;
    const key = input.dataset.traceField as "x" | "y" | "width" | "height" | "opacity";
    const value = Number(input.value);
    trace[key] = key === "opacity" ? Math.max(0, Math.min(1, value)) : key === "width" || key === "height" ? Math.max(.01, value) : value;
  })));
  host.querySelectorAll<HTMLButtonElement>("[data-remove-trace]").forEach((button) => button.addEventListener("click", () => mutate(() => { state.drafting.traceImages.splice(Number(button.dataset.removeTrace), 1); })));
}

function bindTraceImageInput(input: HTMLInputElement): void {
  input.addEventListener("change", () => {
    const file = input.files?.[0]; if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result); const image = new Image();
      image.addEventListener("load", () => mutate(() => {
        const width = 20, height = width * (image.naturalHeight || 1) / (image.naturalWidth || 1);
        state.drafting.traceImages.push({ id: crypto.randomUUID(), dataUrl, x: 0, y: 0, width, height, opacity: .35, rotation: 0 });
        selection = { kind: "trace", index: state.drafting.traceImages.length - 1 }; selections = [selection];
      })); image.addEventListener("error", () => setStatus("error", "That image could not be loaded"));
      image.src = dataUrl;
    });
    reader.readAsDataURL(file); input.value = "";
  });
}

function addSceneText(): void {
  const points = resolveGeometry(toProblem(state)).container.flat();
  const centerX = points.length ? (Math.min(...points.map((point) => point.x)) + Math.max(...points.map((point) => point.x))) / 2 : 0;
  const centerY = points.length ? (Math.min(...points.map((point) => point.y)) + Math.max(...points.map((point) => point.y))) / 2 : 0;
  const step = Math.max(state.drafting.gridStep, 1e-6), x = state.drafting.snapToGrid ? Math.round(centerX / step) * step : centerX, y = state.drafting.snapToGrid ? Math.round(centerY / step) * step : centerY;
  mutate(() => {
    state.drafting.texts.push({ id: crypto.randomUUID(), text: "Annotation", x: roundForEditor(x), y: roundForEditor(y), fontSize: 1.5, rotation: 0, color: "#e8edf3", fontFamily: "mono", align: "left", bold: false, italic: false, underline: false });
    selection = { kind: "text", index: state.drafting.texts.length - 1 }; selections = [selection];
  });
  requestAnimationFrame(() => cad.focusSelection());
}

function renderEntityPreviews(): void {
  const problem = toProblem(state);
  const geometry = resolveGeometry(problem);
  document.querySelectorAll<HTMLCanvasElement>("[data-entity-preview]").forEach((canvas) => {
    const target = parseSelection(canvas.dataset.entityPreview!);
    if (target.kind === "container") {
      const primitive = state.containerParts[target.index]?.primitive;
      const polygon = primitive ? shapePoints(primitiveShape(primitive)).map((point) => transformPoint(point, primitive.rotation, 0, 0)) : [];
      renderPolygonsPreview(canvas, polygon.length ? [polygon] : [], { transparent: true });
    }
    else if (target.kind === "exclusion") renderPolygonsPreview(canvas, geometry.exclusions[target.index]?.polygons ?? [], { transparent: true });
    else if (target.kind === "item") renderPolygonsPreview(canvas, geometry.items[target.index]?.polygons ?? [], { transparent: true });
  });
}

function selectedObject(): object | null {
  if (!selection || selection.kind === "placement" || selection.kind === "auto-dimension" || selection.kind === "dimension" || selection.kind === "guide" || selection.kind === "drafting" || selection.kind === "trace" || selection.kind === "text") return null;
  if (selection.kind === "container") return state.containerParts[selection.index];
  if (selection.kind === "exclusion") return state.exclusions[selection.index];
  return state.items[selection.index];
}

function selectedPrimitive(): PrimitiveEditor | null {
  if (!selection || selection.kind === "placement") return null;
  if (selection.kind === "container") return state.containerParts[selection.index]?.primitive ?? null;
  if (selection.kind === "exclusion") return state.exclusions[selection.index]?.parts[selectedPartIndex] ?? null;
  if (selection.kind === "item") return state.items[selection.index]?.parts[selectedPartIndex] ?? null;
  return null;
}

function selectedPrimitivesForColor(): PrimitiveEditor[] {
  if (selections.some(isLocked)) return [];
  if (selections.length <= 1) return selectedPrimitive() ? [selectedPrimitive()!] : [];
  const parts: PrimitiveEditor[] = [];
  selections.forEach((entry) => {
    if (entry.kind === "container") {
      const primitive = state.containerParts[entry.index]?.primitive; if (primitive) parts.push(primitive);
    } else if (entry.kind === "exclusion") {
      const values = state.exclusions[entry.index]?.parts ?? []; parts.push(...(entry.partIndex === undefined ? values : values[entry.partIndex] ? [values[entry.partIndex]] : []));
    } else if (entry.kind === "item") {
      const values = state.items[entry.index]?.parts ?? []; parts.push(...(entry.partIndex === undefined ? values : values[entry.partIndex] ? [values[entry.partIndex]] : []));
    } else if (entry.kind === "placement") {
      const itemId = currentResult?.placements[entry.index]?.item_id;
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (item) parts.push(...item.parts);
    }
  });
  return [...new Set(parts)];
}

function selectedTextsForColor(): EditorState["drafting"]["texts"] {
  if (selections.some(isLocked)) return [];
  return selections.flatMap((entry) => entry.kind === "text" && state.drafting.texts[entry.index] ? [state.drafting.texts[entry.index]] : []);
}

function selectedConstraintParts(): PrimitiveEditor[] | null {
  if (selection?.kind === "item") return state.items[selection.index]?.parts ?? null;
  if (selection?.kind === "container") return state.containerParts.map((entry) => entry.primitive);
  if (selection?.kind === "exclusion") return state.exclusions[selection.index]?.parts ?? null;
  return null;
}

function selectedOwnerKey(): string {
  if (selection?.kind === "container") return "container";
  if (selection?.kind === "item") return `item:${selection.index}`;
  if (selection?.kind === "exclusion") return `exclusion:${selection.index}`;
  return "";
}

function partOwnerOptions(): string {
  const current = selectedOwnerKey();
  const options: Array<[string, string]> = [["container", "Container material"]];
  state.items.forEach((item, index) => options.push([`item:${index}`, `Packable shape · ${item.id}`]));
  state.exclusions.forEach((entry, index) => options.push([`exclusion:${index}`, `Exclusion · ${entry.id}`]));
  return options.map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function moveSelectedPart(targetOwner: string): void {
  if (!selection || selection.kind === "placement" || targetOwner === selectedOwnerKey()) return;
  mutate(() => {
    if (!selection || selection.kind === "placement") return;
    const sourceSelection = selection, sourceParts = selectedConstraintParts();
    const sourceIndex = sourceSelection.kind === "container" ? sourceSelection.index : selectedPartIndex;
    const part = sourceParts?.[sourceIndex]; if (!sourceParts || !part) return;
    const positions = resolveEditorTranslations(sourceParts), position = positions.get(part.id) ?? { x: part.x, y: part.y };
    sourceParts.forEach((dependent) => {
      if (dependent.snap?.targetId !== part.id) return;
      const dependentPosition = positions.get(dependent.id) ?? { x: dependent.x, y: dependent.y };
      dependent.x = dependentPosition.x; dependent.y = dependentPosition.y; delete dependent.snap;
    });
    if (sourceSelection.kind === "container") state.containerParts.splice(sourceSelection.index, 1);
    else if (sourceSelection.kind === "item") state.items[sourceSelection.index].parts.splice(sourceIndex, 1);
    else state.exclusions[sourceSelection.index].parts.splice(sourceIndex, 1);
    part.x = position.x; part.y = position.y; delete part.snap;

    const [kind, rawIndex] = targetOwner.split(":"), targetIndex = Number(rawIndex);
    if (kind === "container") {
      state.containerParts.push({ id: uniqueId(part.id, state.containerParts.map((entry) => entry.id)), operation: "add", primitive: part });
      selection = { kind: "container", index: state.containerParts.length - 1 }; selectedPartIndex = 0;
    } else if (kind === "item" && state.items[targetIndex]) {
      state.items[targetIndex].parts.push(part); selection = { kind: "item", index: targetIndex }; selectedPartIndex = state.items[targetIndex].parts.length - 1;
    } else if (kind === "exclusion" && state.exclusions[targetIndex]) {
      state.exclusions[targetIndex].parts.push(part); selection = { kind: "exclusion", index: targetIndex }; selectedPartIndex = state.exclusions[targetIndex].parts.length - 1;
    }
  });
  selections = selection ? [selection] : [];
  refreshPacking(true);
}

function setDraftPathTool(tool: "line" | "polyline" | null): void {
  const next = activeDraftPathTool === tool ? null : tool; activeDraftPathTool = next; cad.setDraftTool(next);
  if (next && activeGuideRotation !== null) { activeGuideRotation = null; syncConstructionGuideButtons(); }
  (["line", "polyline"] as const).forEach((kind) => {
    const button = element<HTMLButtonElement>(kind === "line" ? "draw-drafting-line" : "draw-drafting-polyline");
    button.classList.toggle("active", next === kind); button.setAttribute("aria-pressed", String(next === kind));
  });
  if (next) setStatus("neutral", next === "line" ? "Click two endpoints for the drafting line" : "Click points; double-click or press Enter to finish");
}

function toggleDimensionTool(force?: boolean): void {
  activeDimensionTool = force ?? !activeDimensionTool;
  if (activeDimensionTool) {
    activeDraftPathTool = null; clearDraftPathTool(); activeGuideRotation = null; syncConstructionGuideButtons();
    display.dimensions = true; state.viewSettings.showDimensions = true; projects.save(state); syncWorkspaceOverlays(); setStatus("neutral", "Click two points on objects to create a dimension · Alt bypasses snapping");
  }
  cad.setDimensionTool(activeDimensionTool);
  const button = element<HTMLButtonElement>("draw-dimension"); button.classList.toggle("active", activeDimensionTool); button.setAttribute("aria-pressed", String(activeDimensionTool));
}

function addDimension(start: Point, end: Point): void {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-8) { setStatus("error", "Dimension endpoints must be different"); return; }
  mutate(() => {
    state.dimensions.push({ id: crypto.randomUUID(), start, end, offset: { x: 0, y: 0 }, textOverride: "" });
    selection = { kind: "dimension", index: state.dimensions.length - 1 }; selections = [selection];
  });
  activeDimensionTool = false;
}

function dimensionChanged(index: number, previous: EditorState): void {
  history.commit(previous, state); projects.save(state); updateHistoryButtons();
  selection = { kind: "dimension", index }; selections = [selection]; renderPackingSidebar(); refreshPacking();
  setStatus("neutral", "Dimension position saved");
}

function automaticDimensionChanged(owner: string, previous: EditorState): void {
  history.commit(previous, state); projects.save(state); updateHistoryButtons(); renderPackingSidebar(); refreshPacking();
  setStatus("neutral", `${owner.startsWith("clearance:") ? "Clearance dimension" : "Dimension"} position saved`);
}

function clearDraftPathTool(): void {
  activeDraftPathTool = null;
  ["draw-drafting-line", "draw-drafting-polyline"].forEach((id) => { const button = element<HTMLButtonElement>(id); button.classList.remove("active"); button.setAttribute("aria-pressed", "false"); });
}

function setConstructionGuideTool(rotation: number | null): void {
  const next = rotation !== null && activeGuideRotation === rotation ? null : rotation;
  activeGuideRotation = next;
  if (next !== null && activeDraftPathTool) { activeDraftPathTool = null; clearDraftPathTool(); cad.setDraftTool(null); }
  cad.setGuideTool(next); syncConstructionGuideButtons(); renderDraftingPanel();
  if (next !== null) setStatus("neutral", `Move over the canvas and click to place the ${next === 90 ? "vertical" : "horizontal"} construction line · Alt bypasses grid snap`);
}

function syncConstructionGuideButtons(): void {
  ([{ id: "add-vertical-guide", rotation: 90 }, { id: "add-horizontal-guide", rotation: 0 }] as const).forEach(({ id, rotation }) => {
    const button = document.getElementById(id) as HTMLButtonElement | null; if (!button) return;
    const active = activeGuideRotation === rotation; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
}

function placeConstructionGuide(point: Point, rotation: number): void {
  mutate(() => {
    const guide = { id: crypto.randomUUID(), x: point.x, y: point.y, rotation };
    state.drafting.guides.push(guide); selection = { kind: "guide", index: state.drafting.guides.length - 1 }; selections = [selection];
  });
  activeGuideRotation = null; syncConstructionGuideButtons(); renderDraftingPanel();
}

function addDraftingPath(points: Point[], closed: boolean): void {
  if (points.length < 2) return;
  // Use a snapped endpoint as the local origin so both the entity position and
  // every captured world point remain aligned to the drafting grid.
  const center = points[0];
  mutate(() => {
    state.drafting.shapes.push({ id: crypto.randomUUID(), points: points.map((point) => ({ x: roundForEditor(point.x - center.x), y: roundForEditor(point.y - center.y) })), x: roundForEditor(center.x), y: roundForEditor(center.y), rotation: 0, closed });
    selection = { kind: "drafting", index: state.drafting.shapes.length - 1 }; selections = [selection];
  });
  clearDraftPathTool();
}

function addObject(kind: string): void {
  mutate(() => {
    if (kind === "item") {
      const id = uniqueId("item", state.items.map((item) => item.id));
      state.items.push({ id, quantity: 50, rotationMode: "continuous", rotationCoupling: "independent", rotations: "0, 90", minRotation: 0, maxRotation: 360, parts: [makePrimitive("rectangle")] });
      selection = { kind: "item", index: state.items.length - 1 };
    } else if (kind === "exclusion") {
      const primitive = makePrimitive("rectangle"); placeAtContainerCenter(primitive);
      state.exclusions.push({ id: uniqueId("exclusion", state.exclusions.map((entry) => entry.id)), clearance: 0, parts: [primitive] });
      selection = { kind: "exclusion", index: state.exclusions.length - 1 };
    } else {
      const operation = kind === "material" ? "add" : "subtract";
      const primitive = makePrimitive("rectangle"); placeAtContainerCenter(primitive);
      state.containerParts.push({ id: uniqueId(operation === "add" ? "material" : "cutout", state.containerParts.map((entry) => entry.id)), operation, primitive });
      selection = { kind: "container", index: state.containerParts.length - 1 };
    }
    selectedPartIndex = 0;
    selections = selection ? [selection] : [];
  });
  refreshPacking(true);
}

function addGeometry(kind: PrimitiveEditor["kind"]): void {
  mutate(() => {
    const primitive = makePrimitive(kind);
    const editableSelection = selection && !isLocked(selection) ? selection : null;
    if (draftingShapeMode) {
      placeAtContainerCenter(primitive);
      if (state.drafting.snapToGrid) {
        primitive.x = roundForEditor(Math.round(primitive.x / state.drafting.gridStep) * state.drafting.gridStep);
        primitive.y = roundForEditor(Math.round(primitive.y / state.drafting.gridStep) * state.drafting.gridStep);
      }
      const points = shapePoints(primitiveShape(primitive));
      state.drafting.shapes.push({ id: crypto.randomUUID(), points, x: primitive.x, y: primitive.y, rotation: primitive.rotation, closed: true });
      selection = { kind: "drafting", index: state.drafting.shapes.length - 1 }; selectedPartIndex = 0; return;
    }
    if (editableSelection?.kind === "item") {
      const item = state.items[editableSelection.index], target = item.parts[selectedPartIndex] ?? item.parts[0];
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      item.parts.push(primitive); selectedPartIndex = item.parts.length - 1;
      selection = { ...editableSelection, partIndex: selectedPartIndex };
      return;
    }
    if (editableSelection?.kind === "container") {
      const selected = state.containerParts[editableSelection.index], target = selected?.primitive;
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      state.containerParts.push({ id: uniqueId(selected?.operation === "subtract" ? "cutout" : "material", state.containerParts.map((entry) => entry.id)), operation: selected?.operation ?? "add", primitive });
      selection = { kind: "container", index: state.containerParts.length - 1 }; selectedPartIndex = 0;
      return;
    }
    if (editableSelection?.kind === "exclusion") {
      const parts = state.exclusions[editableSelection.index].parts, target = parts[selectedPartIndex] ?? parts[0];
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      parts.push(primitive); selectedPartIndex = parts.length - 1;
      selection = { ...editableSelection, partIndex: selectedPartIndex };
      return;
    }
    placeAtContainerCenter(primitive);
    if (state.drafting.defaultOwner === "item") {
      state.items.push({ id: uniqueId("item", state.items.map((entry) => entry.id)), quantity: 50, rotationMode: "continuous", rotationCoupling: "independent", rotations: "0, 90", minRotation: 0, maxRotation: 360, parts: [primitive] });
      selection = { kind: "item", index: state.items.length - 1 };
    } else if (state.drafting.defaultOwner === "exclusion") {
      state.exclusions.push({ id: uniqueId("exclusion", state.exclusions.map((entry) => entry.id)), clearance: 0, parts: [primitive] });
      selection = { kind: "exclusion", index: state.exclusions.length - 1 };
    } else {
      const operation = state.drafting.defaultOwner === "cutout" ? "subtract" : "add";
      state.containerParts.push({ id: uniqueId(state.drafting.defaultOwner, state.containerParts.map((entry) => entry.id)), operation, primitive });
      selection = { kind: "container", index: state.containerParts.length - 1 };
    }
    selectedPartIndex = 0;
  });
  selections = selection ? [selection] : [];
  refreshPacking(true);
}

function joinSelectedMaterial(): void {
  if (selection?.kind !== "container" || isLocked(selection)) return;
  const selectedIndex = selection.index;
  mutate(() => {
    const selected = state.containerParts[selectedIndex]; if (!selected || selected.operation !== "add") return;
    const primitives = state.containerParts.map((entry) => entry.primitive);
    const target = state.containerParts.find((entry, index) => index !== selectedIndex && entry.operation === "add" && !primitiveDependsOn(primitives, entry.primitive.id, selected.primitive.id));
    if (!target) return;
    selected.primitive.snap = { targetId: target.primitive.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
  });
  setStatus("success", "Material joined · additive regions are unified for packing");
}

function deleteToolbarSelection(): void {
  if (selections.some(isLocked)) return;
  if (selections.length > 1) { deleteMultipleSelections(); return; }
  if (!selection || selection.kind === "placement" || selection.kind === "auto-dimension") return;
  if (selection.kind === "container" || selection.kind === "guide" || selection.kind === "drafting" || selection.kind === "dimension" || selection.kind === "text" || selection.kind === "trace" || ((selection.kind === "item" || selection.kind === "exclusion") && selection.partIndex === undefined)) { deleteSelectedObject(); return; }
  mutate(deleteSelectedPart);
}

function deleteMultipleSelections(): void {
  const definitions = selections.filter((entry) => entry.kind !== "placement");
  if (definitions.length) {
    mutate(() => {
      const remove = (kind: CadSelection["kind"], values: unknown[]) => selections
        .filter((entry) => entry.kind === kind && !isPartSelection(entry))
        .map((entry) => entry.index)
        .sort((a, b) => b - a)
        .forEach((index) => values.splice(index, 1));
      remove("container", state.containerParts);
      remove("exclusion", state.exclusions);
      remove("item", state.items);
      remove("guide", state.drafting.guides);
      remove("drafting", state.drafting.shapes);
      remove("dimension", state.dimensions);
      remove("trace", state.drafting.traceImages);
      remove("text", state.drafting.texts);
      const removeParts = (kind: "item" | "exclusion", owners: Array<{ parts: PrimitiveEditor[] }>) => selections
        .flatMap((entry) => entry.kind === kind && entry.partIndex !== undefined
          && !selections.some((whole) => whole.kind === kind && whole.index === entry.index && whole.partIndex === undefined)
          ? [{ index: entry.index, partIndex: entry.partIndex }] : [])
        .sort((a, b) => b.index - a.index || b.partIndex - a.partIndex)
        .forEach((entry) => owners[entry.index]?.parts.splice(entry.partIndex, 1));
      removeParts("item", state.items); removeParts("exclusion", state.exclusions);
      for (let index = state.items.length - 1; index >= 0; index--) if (state.items[index].parts.length === 0) state.items.splice(index, 1);
      for (let index = state.exclusions.length - 1; index >= 0; index--) if (state.exclusions[index].parts.length === 0) state.exclusions.splice(index, 1);
      selection = null; selections = []; selectedPartIndex = 0;
    });
    refreshPacking(true);
    return;
  }
  if (!currentResult) return;
  const indexes = selections.map((entry) => entry.index).sort((a, b) => b - a);
  indexes.forEach((index) => currentResult?.placements.splice(index, 1));
  currentResult.packed_item_count = currentResult.placements.length;
  currentResult.packed_count_by_item = currentResult.placements.reduce<Record<string, number>>((counts, placement) => {
    counts[placement.item_id] = (counts[placement.item_id] ?? 0) + 1; return counts;
  }, {});
  manualLayout = true; selection = null; selections = [];
  refreshPacking(); renderPackingSidebar(); updateDiagnostics();
  setStatus("neutral", "Selected placements deleted · validation is now stale");
}

function deleteSelectedPart(): void {
  const parts = selectedConstraintParts(); if (!parts?.[selectedPartIndex]) return;
  const removed = parts[selectedPartIndex].id; parts.splice(selectedPartIndex, 1);
  parts.forEach((part) => { if (part.snap?.targetId === removed) delete part.snap; });
  if (parts.length === 0 && selection?.kind === "item") {
    state.items.splice(selection.index, 1); selection = null; selections = [];
  } else if (parts.length === 0 && selection?.kind === "exclusion") {
    state.exclusions.splice(selection.index, 1); selection = null; selections = [];
  }
  selectedPartIndex = Math.min(selectedPartIndex, Math.max(0, parts.length - 1));
  if (selection && (selection.kind === "item" || selection.kind === "exclusion")) {
    selection = { ...selection, partIndex: selectedPartIndex }; selections = [selection];
  }
}

function updateToolbarState(): void {
  const selectedRegion = selection?.kind === "container" && !isLocked(selection) ? state.containerParts[selection.index] : null;
  const primitives = state.containerParts.map((entry) => entry.primitive);
  const canJoin = selectedRegion?.operation === "add" && state.containerParts.some((entry) => entry !== selectedRegion && entry.operation === "add" && !primitiveDependsOn(primitives, entry.primitive.id, selectedRegion.primitive.id));
  element<HTMLButtonElement>("join-material").disabled = !canJoin;
  element<HTMLButtonElement>("delete-selection").disabled = selections.length === 0 || selections.some(isLocked) || (selections.length === 1 && (selection?.kind === "placement" || selection?.kind === "auto-dimension"));
  const lock = element<HTMLButtonElement>("lock-selection"), unlock = selections.length === 1 && !!selection && isLocked(selection);
  lock.disabled = selections.length === 0 || selection?.kind === "auto-dimension"; lock.setAttribute("aria-label", unlock ? "Unlock selection" : "Lock selection");
  lock.title = unlock ? "Unlock this entity for CAD interaction" : "Lock selected entities against CAD interaction";
  lock.classList.toggle("active", unlock);
  const color = element<HTMLInputElement>("toolbar-part-color"), parts = selectedPrimitivesForColor(), texts = selectedTextsForColor();
  color.disabled = parts.length === 0 && texts.length === 0; color.value = texts[0]?.color ?? editorColor(parts[0]);
  const trace = element<HTMLButtonElement>("add-trace-image"); trace.classList.toggle("has-content", state.drafting.traceImages.length > 0);
  trace.title = state.drafting.traceImages.length ? "Add another tracing image" : "Add a transparent tracing image";
}

function deleteSelectedObject(): void {
  if (!selection || selection.kind === "placement") return;
  mutate(() => {
    if (selection?.kind === "item") { state.items.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "exclusion") { state.exclusions.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "container") {
      state.containerParts.splice(selection.index, 1); selection = null;
    }
    else if (selection?.kind === "guide") { state.drafting.guides.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "drafting") { state.drafting.shapes.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "dimension") { state.dimensions.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "trace") { state.drafting.traceImages.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "text") { state.drafting.texts.splice(selection.index, 1); selection = null; }
    selections = []; selectedPartIndex = 0;
  });
  refreshPacking(true);
}

function duplicateContextSelection(): void {
  if (!selection) return;
  if (selection.kind === "item" || selection.kind === "placement") { copySelectedItems(); pasteItems(); return; }
  const step = Math.max(state.drafting.gridStep, .1);
  mutate(() => {
    if (!selection) return;
    const cloneEntry = <T extends { id: string }>(source: T | undefined): T | null => source ? { ...structuredClone(source), id: crypto.randomUUID() } : null;
    if (selection.kind === "text") {
      const copy = cloneEntry(state.drafting.texts[selection.index]); if (!copy) return; copy.x += step; copy.y -= step;
      state.drafting.texts.push(copy); selection = { kind: "text", index: state.drafting.texts.length - 1 };
    } else if (selection.kind === "trace") {
      const copy = cloneEntry(state.drafting.traceImages[selection.index]); if (!copy) return; copy.x += step; copy.y -= step;
      state.drafting.traceImages.push(copy); selection = { kind: "trace", index: state.drafting.traceImages.length - 1 };
    } else if (selection.kind === "drafting") {
      const copy = cloneEntry(state.drafting.shapes[selection.index]); if (!copy) return; copy.x += step; copy.y -= step;
      state.drafting.shapes.push(copy); selection = { kind: "drafting", index: state.drafting.shapes.length - 1 };
    } else if (selection.kind === "guide") {
      const copy = cloneEntry(state.drafting.guides[selection.index]); if (!copy) return; copy.x += step; copy.y -= step;
      state.drafting.guides.push(copy); selection = { kind: "guide", index: state.drafting.guides.length - 1 };
    } else if (selection.kind === "dimension") {
      const copy = cloneEntry(state.dimensions[selection.index]); if (!copy) return;
      copy.start = { x: copy.start.x + step, y: copy.start.y - step }; copy.end = { x: copy.end.x + step, y: copy.end.y - step };
      state.dimensions.push(copy); selection = { kind: "dimension", index: state.dimensions.length - 1 };
    }
    selections = selection ? [selection] : [];
  });
}

function reorderContextSelection(direction: "front" | "back"): void {
  if (!selection) return;
  mutate(() => {
    if (!selection) return;
    const values = selection.kind === "text" ? state.drafting.texts : selection.kind === "trace" ? state.drafting.traceImages
      : selection.kind === "drafting" ? state.drafting.shapes : selection.kind === "dimension" ? state.dimensions : null;
    if (!values) return;
    const entries = values as unknown as unknown[], [entry] = entries.splice(selection.index, 1); if (!entry) return;
    if (direction === "front") entries.push(entry); else entries.unshift(entry);
    selection = { ...selection, index: direction === "front" ? entries.length - 1 : 0 } as CadSelection; selections = [selection];
  });
}

function resetSelectionRotation(): void {
  if (!selection) return;
  if (selection.kind === "placement" && currentResult?.placements[selection.index]) {
    currentResult.placements[selection.index].rotation_deg = 0; placementChanged(selection.index, currentResult.placements[selection.index]); return;
  }
  mutate(() => {
    if (!selection) return;
    if (selection.kind === "text") state.drafting.texts[selection.index].rotation = 0;
    else if (selection.kind === "trace") state.drafting.traceImages[selection.index].rotation = 0;
    else if (selection.kind === "drafting") state.drafting.shapes[selection.index].rotation = 0;
    else if (selection.kind === "guide") state.drafting.guides[selection.index].rotation = 0;
    else { const primitive = selectedPrimitive(); if (primitive) primitive.rotation = 0; }
  });
}

function copySelectedItems(): void {
  if (selections.some(isLocked)) { setStatus("neutral", "Unlock the entity before copying it"); return; }
  const placementIndexes = selections.filter((entry) => entry.kind === "placement").map((entry) => entry.index);
  if (placementIndexes.length && currentResult) {
    placementClipboard = placementIndexes.map((index) => currentResult!.placements[index]).filter(Boolean).map((entry) => structuredClone(entry));
    itemClipboard = []; partClipboard = null;
    setStatus("success", `${placementClipboard.length} solved placement${placementClipboard.length === 1 ? "" : "s"} copied`); return;
  }
  const explicitItems = selections.filter((entry) => entry.kind === "item" && entry.partIndex === undefined).map((entry) => entry.index);
  const selectedItemParts = selections.filter((entry): entry is Extract<CadSelection, { kind: "item" }> & { partIndex: number } => entry.kind === "item" && entry.partIndex !== undefined);
  const fullySelectedItems = [...new Set(selectedItemParts.map((entry) => entry.index))].filter((index) => {
    const item = state.items[index];
    return !!item?.parts.length && item.parts.every((_part, partIndex) => selectedItemParts.some((entry) => entry.index === index && entry.partIndex === partIndex));
  });
  const indexes = [...new Set([...explicitItems, ...fullySelectedItems])];
  itemClipboard = indexes.map((index) => state.items[index]).filter(Boolean).map((item) => structuredClone(item));
  const partial = selectedItemParts.filter((entry) => !indexes.includes(entry.index));
  if (!itemClipboard.length && partial.length) {
    const ownerIndex = partial[0].index;
    const parts = partial.filter((entry) => entry.index === ownerIndex).map((entry) => state.items[ownerIndex]?.parts[entry.partIndex]).filter(Boolean);
    partClipboard = { owner: { kind: "item", index: ownerIndex }, parts: structuredClone(parts) };
  } else if (!itemClipboard.length) {
    const exclusionParts = selections.filter((entry): entry is Extract<CadSelection, { kind: "exclusion" }> & { partIndex: number } => entry.kind === "exclusion" && entry.partIndex !== undefined);
    const ownerIndex = exclusionParts[0]?.index;
    const parts = ownerIndex === undefined ? [] : exclusionParts.filter((entry) => entry.index === ownerIndex).map((entry) => state.exclusions[ownerIndex]?.parts[entry.partIndex]).filter(Boolean);
    partClipboard = parts.length ? { owner: { kind: "exclusion", index: ownerIndex }, parts: structuredClone(parts) } : null;
  } else partClipboard = null;
  placementClipboard = [];
  const copied = itemClipboard.length || partClipboard?.parts.length || 0;
  setStatus(copied ? "success" : "neutral", itemClipboard.length
    ? `${itemClipboard.length} complete item${itemClipboard.length === 1 ? "" : "s"} copied`
    : partClipboard ? `${partClipboard.parts.length} constituent shape${partClipboard.parts.length === 1 ? "" : "s"} copied`
      : "Select an item or constituent shape to copy");
}

function pasteItems(): void {
  if (selection && isLocked(selection)) { setStatus("neutral", "Unlock the entity before editing it"); return; }
  if (placementClipboard.length && currentResult) {
    const start = currentResult.placements.length;
    const copies = placementClipboard.map((source) => ({ ...structuredClone(source), x: source.x + 1, y: source.y - 1, fixed: false }));
    currentResult.placements.push(...copies); currentResult.packed_item_count = currentResult.placements.length;
    selections = copies.map((_, offset) => ({ kind: "placement", index: start + offset })); selection = selections.at(-1) ?? null;
    manualLayout = true; resultStale = true; refreshPacking(); renderPackingSidebar(); updateDiagnostics();
    setStatus("neutral", `${copies.length} placement${copies.length === 1 ? "" : "s"} pasted · validation is stale`); return;
  }
  if (partClipboard?.parts.length) {
    mutate(() => {
      const destination = selection?.kind === partClipboard!.owner.kind ? selectedConstraintParts()
        : partClipboard!.owner.kind === "item" ? state.items[partClipboard!.owner.index]?.parts : state.exclusions[partClipboard!.owner.index]?.parts;
      if (!destination) return;
      const idMap = new Map<string, string>();
      const copies = structuredClone(partClipboard!.parts);
      const used = destination.map((part) => part.id);
      copies.forEach((part) => { const id = uniqueId(`${part.id}-copy`, [...used, ...idMap.values()]); idMap.set(part.id, id); part.id = id; });
      copies.forEach((part, index) => {
        const source = partClipboard!.parts[index];
        if (source.snap && idMap.has(source.snap.targetId)) part.snap!.targetId = idMap.get(source.snap.targetId)!;
        else if (part.snap && !destination.some((target) => target.id === part.snap!.targetId)) delete part.snap;
        if (!part.snap) { part.x = roundForEditor(part.x + state.options.grid_step); part.y = roundForEditor(part.y - state.options.grid_step); }
      });
      const start = destination.length; destination.push(...copies); selectedPartIndex = destination.length - 1;
      if (selection?.kind !== partClipboard!.owner.kind) selection = { kind: partClipboard!.owner.kind, index: partClipboard!.owner.index };
      selections = copies.map((_part, offset) => ({ ...selection!, partIndex: start + offset } as CadSelection));
      selection = selections.at(-1) ?? selection;
    });
    refreshPacking(true);
    setStatus("success", `${partClipboard.parts.length} constituent shape${partClipboard.parts.length === 1 ? "" : "s"} pasted into the construction`);
    return;
  }
  if (!itemClipboard.length) { setStatus("neutral", "Copy a packable item before pasting"); return; }
  mutate(() => {
    const added: CadSelection[] = [];
    itemClipboard.forEach((source) => {
      const item = structuredClone(source);
      item.id = uniqueId(`${source.id}-copy`, state.items.map((entry) => entry.id));
      state.items.push(item);
      added.push({ kind: "item", index: state.items.length - 1 });
    });
    selections = added; selection = added.at(-1) ?? null; selectedPartIndex = 0;
  });
  refreshPacking(true);
  setStatus("success", `${itemClipboard.length} new item${itemClipboard.length === 1 ? "" : "s"} pasted`);
}

function roundForEditor(value: number): number { return Math.round(value * 1000) / 1000; }
function mirrorPoint(point: { x: number; y: number }, axis: "x" | "y"): { x: number; y: number } {
  return axis === "x" ? { x: -point.x, y: point.y } : { x: point.x, y: -point.y };
}

function openProjects(): void {
  renderProjectDialog();
  element<HTMLDialogElement>("project-dialog").showModal();
}

function renderProjectDialog(): void {
  const host = element("project-dialog-body");
  host.innerHTML = projectDialogHtml(projects.projects, projects.activeProjectId, toProblem(state));
  host.querySelector<HTMLSelectElement>("#project-select")!.addEventListener("change", (event) => { projects.save(state); loadProject((event.target as HTMLSelectElement).value); renderProjectDialog(); });
  host.querySelector("#save-project")!.addEventListener("click", () => {
    try { projects.rename(host.querySelector<HTMLInputElement>("#project-name")!.value); projects.save(state); renderPackingSidebar(); setStatus("success", "Project saved on this device"); renderProjectDialog(); }
    catch (error) { setStatus("error", errorMessage(error)); }
  });
  host.querySelector("#new-project")!.addEventListener("click", () => { projects.save(state); loadProject(projects.create().id); renderProjectDialog(); });
  host.querySelector("#empty-project")!.addEventListener("click", () => { projects.save(state); loadProject(projects.create(undefined, true).id); renderProjectDialog(); });
  host.querySelector("#duplicate-project")!.addEventListener("click", () => { projects.save(state); loadProject(projects.duplicate().id); renderProjectDialog(); });
  host.querySelector("#delete-project")!.addEventListener("click", () => {
    try { const name = projects.active.name; if (!confirm(`Delete “${name}” from this device?`)) return; loadProject(projects.deleteActive().id); renderProjectDialog(); }
    catch (error) { setStatus("error", errorMessage(error)); }
  });
  host.querySelector("#load-json")!.addEventListener("click", () => mutate(() => {
    const problem = JSON.parse(host.querySelector<HTMLTextAreaElement>("#problem-json")!.value) as PackingProblem;
    const options = state.options, study = state.study; state = fromProblem(problem); state.options = options; state.study = study;
  }));
  host.querySelector("#copy-problem")!.addEventListener("click", () => void navigator.clipboard.writeText(JSON.stringify(toProblem(state), null, 2)));
}

function loadProject(id: string): void {
  const project = projects.switch(id);
  state = structuredClone(project.state); history.clear(); clearResults();
  display.dimensions = state.viewSettings.showDimensions; display.clearance = state.viewSettings.showClearance;
  selection = { kind: "container", index: 0 };
  selections = [selection];
  renderPackingSidebar(); renderSensitivitySidebar(); updateHistoryButtons(); showPage("packing"); refreshPacking(true);
  setStatus("success", `Opened ${project.name}`);
}

function renderSensitivitySidebar(): void {
  const sidebar = element("sensitivity-sidebar");
  const optionsHtml = parameterOptions();
  const selectedParameter = parameterCatalog(state).find((entry) => entry.key === state.study.parameterKey);
  sidebar.innerHTML = sensitivitySidebarHtml(state, optionsHtml, selectedParameter, parameterCurrentValue(state, state.study.parameterKey));
  sidebar.querySelector<HTMLSelectElement>("#study-parameter")!.addEventListener("change", (event) => studyChange(() => { state.study.parameterKey = (event.target as HTMLSelectElement).value; }));
  sidebar.querySelector<HTMLInputElement>("#study-parameter-search")!.addEventListener("input", renderParameterMatches);
  sidebar.querySelector("#suggest-study-range")!.addEventListener("click", suggestStudyRange);
  sidebar.querySelector<HTMLSelectElement>("#study-strategy")!.addEventListener("change", (event) => studyChange(() => { state.study.strategy = (event.target as HTMLSelectElement).value as EditorState["study"]["strategy"]; }));
  sidebar.querySelector<HTMLSelectElement>("#seed-policy")!.addEventListener("change", (event) => studyChange(() => { state.study.seed_policy = (event.target as HTMLSelectElement).value as EditorState["study"]["seed_policy"]; }));
  sidebar.querySelectorAll<HTMLInputElement>("[data-study-field]").forEach((input) => input.addEventListener("change", () => studyChange(() => setField(state.study, input.dataset.studyField!, Number(input.value)))));
  sidebar.querySelector("#run-study")!.addEventListener("click", () => void runStudy());
  requestAnimationFrame(renderStudyGeometryPreview);
}

function renderParameterMatches(event: Event): void {
  const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
  const host = element("study-parameter-matches");
  if (!query) { host.innerHTML = ""; return; }
  const matches = parameterCatalog(state).filter((entry) => `${entry.group} ${entry.label}`.toLowerCase().includes(query)).slice(0, 8);
  host.innerHTML = parameterMatchesHtml(matches.map((entry) => ({ ...entry, currentValue: parameterCurrentValue(state, entry.key) })));
  host.querySelectorAll<HTMLButtonElement>("[data-parameter-key]").forEach((button) => button.addEventListener("click", () => studyChange(() => { state.study.parameterKey = button.dataset.parameterKey!; })));
}

function suggestStudyRange(): void {
  studyChange(() => {
    const current = parameterCurrentValue(state, state.study.parameterKey);
    const quantity = state.study.parameterKey.startsWith("item_quantity:");
    const delta = quantity ? Math.max(2, Math.round(current * .25)) : Math.max(Math.abs(current) * .25, .25);
    state.study.start = quantity ? Math.max(0, Math.round(current - delta)) : Number((current - delta).toPrecision(6));
    state.study.end = quantity ? Math.round(current + delta) : Number((current + delta).toPrecision(6));
    state.study.initial_step = quantity ? Math.max(1, Math.round(delta / 2)) : Number(Math.max(delta / 3, .01).toPrecision(4));
  });
}

function studyChange(change: () => void): void { mutate(change, false); renderSensitivitySidebar(); refreshSensitivityPage(); setStatus("neutral", "Study configuration changed"); }

function renderStudyGeometryPreview(): void {
  const host = element("study-shape-preview");
  const values = studyValues(state.study.start, state.study.end, state.study.initial_step);
  const itemIndex = itemIndexForParameter(state.study.parameterKey);
  host.innerHTML = studyStepsHtml(values);
  host.querySelectorAll<HTMLCanvasElement>("[data-study-preview]").forEach((canvas, index) => {
    const previewState = stateAtParameter(state, values[index]);
    const previewProblem = toProblem(previewState);
    if (itemIndex >= 0) renderPolygonsPreview(canvas, resolveGeometry(previewProblem).items[itemIndex]?.polygons ?? [], { dimensions: studyDisplay.dimensions, clearance: studyDisplay.clearance ? previewProblem.clearance.item_to_item / 2 : 0 });
    else renderLayout(canvas, previewProblem, [], studyDisplay);
  });
}

async function solve(): Promise<void> {
  if (running) return;
  try {
    const problem = toProblem(state); setRunning(true, "Preparing geometry…"); currentResult = null; manualLayout = false; resultStale = false;
    currentResult = await client.solve(problem, state.options, (progress) => updateProgress(problem, progress));
    setStatus("success", `${currentResult.packed_item_count} items · ${state.options.baseline_only ? "Baseline validated" : humanize(currentResult.status)}`); showPackingResult(problem, currentResult);
  } catch (error) { handleRunError(error); } finally { setRunning(false); }
}

async function validate(): Promise<void> {
  try { setStatus("working", "Validating geometry…"); await client.validate(toProblem(state)); setStatus("success", "Problem geometry is valid"); }
  catch (error) { setStatus("error", errorMessage(error)); }
}

async function runStudy(): Promise<void> {
  if (running) return;
  try {
    const problem = toProblem(state); setRunning(true, "Running parameter study…"); sensitivitySelection = null; resetStudyProgress();
    sensitivityResult = await client.sensitivity(problem, buildStudy(), updateStudyProgress);
    sensitivitySelection = sensitivityResult.evaluations[0]?.value ?? null; renderSensitivityResults(); completeStudyProgress(sensitivityResult.evaluations.length);
    if (sensitivitySelection !== null) selectSensitivityEvaluation(sensitivitySelection, "first");
    setStatus("success", `${sensitivityResult.evaluations.length} parameter values evaluated`);
  } catch (error) { handleRunError(error); } finally { setRunning(false); }
}

function updateProgress(problem: PackingProblem, progress: SolveProgress): void {
  element<HTMLProgressElement>("solve-progress").value = Math.round(progress.completed_fraction * 100);
  element("solve-stage").textContent = humanize(progress.phase);
  element("solve-detail").textContent = `${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`;
  setStatus("working", `${humanize(progress.phase)} · ${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`);
  cad.setModel(state, problem, progress.placements);
  element("workspace-summary").textContent = `Improving · ${progress.packed_item_count} items`;
}

function showPackingResult(problem: PackingProblem, result: SolveResult): void {
  cad.setModel(state, problem, result.placements);
  element("workspace-summary").textContent = `${result.packed_item_count} packed items`;
  updateDiagnostics();
}

function placementChanged(index: number, placement: Placement): void {
  if (!currentResult && !running && state.fixedPlacements[index]) {
    const before = structuredClone(state); Object.assign(state.fixedPlacements[index], { x: placement.x, y: placement.y, rotation_deg: placement.rotation_deg });
    history.commit(before, state); projects.save(state); updateHistoryButtons(); refreshPacking(); renderPackingSidebar();
    setStatus("success", `Fixed placement moved to ${format(placement.x)}, ${format(placement.y)}`); return;
  }
  if (!currentResult?.placements[index]) return;
  manualLayout = true;
  cad.setModel(state, toProblem(state), currentResult.placements);
  renderPackingSidebar();
  element("workspace-summary").textContent = `${currentResult.packed_item_count} items · manual layout`;
  setStatus("neutral", "Manual layout changed · validation is now stale");
  updateDiagnostics();
}

function updateDiagnostics(): void {
  element("diagnostics").innerHTML = diagnosticsHtml(currentResult, manualLayout, resultStale);
}

function renderSensitivityResults(): void { renderSensitivity(element("sensitivity-canvas"), sensitivityResult, sensitivitySelection); renderTransitions(); }

function renderTransitions(): void {
  const host = element("transitions");
  host.innerHTML = transitionsHtml(sensitivityResult);
  if (!sensitivityResult) return;
  host.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", () => selectSensitivityEvaluation(Number(button.dataset.value), button.querySelector("b")!.textContent!.toLowerCase())));
}

function selectSensitivityEvaluation(value: number, side: string): void {
  if (!sensitivityResult) return;
  const evaluation = sensitivityResult.evaluations.reduce((best, entry) => Math.abs(entry.value - value) < Math.abs(best.value - value) ? entry : best);
  sensitivitySelection = evaluation.value; renderSensitivity(element("sensitivity-canvas"), sensitivityResult, evaluation.value);
  renderLayout(element("sensitivity-layout-canvas"), evaluation.problem, evaluation.result.placements, studyDisplay);
  element("sensitivity-layout-title").textContent = `${evaluation.capacity} items at ${format(evaluation.value)}`;
  element("sensitivity-layout-id").textContent = evaluation.result.layout_id;
  element<HTMLButtonElement>("edit-selected-layout").disabled = false;
  element("sensitivity-metrics").innerHTML = metricsHtml(evaluation.result);
  element("transitions").querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.value) === evaluation.value));
  setStatus("neutral", `Viewing ${side} point ${format(evaluation.value)} · ${evaluation.capacity} items`);
}

function definitionChanged(next: Exclude<CadSelection, { kind: "placement" }>, previous: EditorState): void {
  history.commit(previous, state); projects.save(state); markResultStale(); updateHistoryButtons();
  selection = next; renderPackingSidebar(); renderSensitivitySidebar(); refreshPacking(); setStatus("neutral", currentResult ? "Geometry changed · solved layout retained but stale" : "Geometry changed · saved locally");
}

function mutate(change: () => void, rerender = true): void {
  const before = structuredClone(state);
  try {
    change(); history.commit(before, state); projects.save(state); markResultStale(); updateHistoryButtons();
    if (rerender) { renderPackingSidebar(); renderSensitivitySidebar(); }
    refreshCurrentPage(); setStatus("neutral", "Changes saved locally");
  } catch (error) { state = before; setStatus("error", errorMessage(error)); }
}

function undo(): void { const restored = history.undo(state); if (restored) restoreHistory(restored, "Undid last workspace action"); }
function redo(): void { const restored = history.redo(state); if (restored) restoreHistory(restored, "Redid workspace action"); }
function restoreHistory(restored: EditorState, message: string): void {
  state = restored; projects.save(state); clearResults(); updateHistoryButtons();
  selection = normalizeSelection(selection); selections = selection ? [selection] : []; renderPackingSidebar(); renderSensitivitySidebar(); refreshCurrentPage(true); setStatus("neutral", message);
}

function clearResults(): void {
  currentResult = null; sensitivityResult = null; sensitivitySelection = null; manualLayout = false; resultStale = false;
  element("workspace-summary").textContent = "Problem definition";
  element("diagnostics").innerHTML = "<p>Run a solve to inspect validation and search statistics.</p>";
  element<HTMLButtonElement>("edit-selected-layout").disabled = true;
  const progress = document.getElementById("study-progress"); if (progress) progress.hidden = true;
}
function markResultStale(): void {
  sensitivityResult = null; sensitivitySelection = null;
  element<HTMLButtonElement>("edit-selected-layout").disabled = true;
  if (currentResult) { resultStale = true; element("workspace-summary").textContent = `${currentResult.packed_item_count} packed items · stale`; updateDiagnostics(); }
  const progress = document.getElementById("study-progress"); if (progress) progress.hidden = true;
}

function refreshCurrentPage(refit = false): void { if (page === "packing") refreshPacking(refit); else refreshSensitivityPage(); }
function refreshPacking(refit = false): void {
  const fixedPreview: Placement[] = state.fixedPlacements.map((placement) => ({ ...placement, fixed: true }));
  try { cad.setModel(state, toProblem(state), currentResult?.placements ?? fixedPreview, refit); cad.setSelection(selection, selectedPartIndex, selections); }
  catch (error) { setStatus("error", errorMessage(error)); }
}
function refreshSensitivityPage(): void { renderStudyGeometryPreview(); renderSensitivityResults(); if (sensitivityResult && sensitivitySelection !== null) selectSensitivityEvaluation(sensitivitySelection, "selected"); }

function parameterOptions(): string {
  const options = parameterCatalog(state);
  if (!options.some((entry) => entry.key === state.study.parameterKey)) state.study.parameterKey = options[0]?.key ?? "container_width";
  return [...new Set(options.map((entry) => entry.group))].map((group) => `<optgroup label="${escapeHtml(group)}">${options.filter((entry) => entry.group === group).map((entry) => `<option value="${escapeHtml(entry.key)}" ${entry.key === state.study.parameterKey ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}</optgroup>`).join("");
}

function buildStudy(): SensitivityStudy { return { parameter: decodeParameter(state.study.parameterKey), start: state.study.start, end: state.study.end, initial_step: state.study.initial_step, transition_tolerance: state.study.transition_tolerance, strategy: state.study.strategy, solve_options: state.options, seed_policy: state.study.seed_policy, increasing_is_harder: state.study.increasing_is_harder }; }
function resetStudyProgress(): void { const host = element("study-progress"), progress = host.querySelector("progress")!; host.hidden = false; progress.value = 0; host.querySelector("span")!.textContent = "Preparing…"; }
function updateStudyProgress(value: SensitivityProgress): void {
  const host = element("study-progress"), progress = host.querySelector("progress")!; host.hidden = false;
  if (value.phase === "sampling") { progress.value = Math.min(100, value.completed / Math.max(value.initial_total, 1) * (state.study.strategy === "adaptive" ? 72 : 100)); host.querySelector("span")!.textContent = `${value.completed}/${value.initial_total} · ${format(value.value)}`; }
  else { progress.removeAttribute("value"); host.querySelector("span")!.textContent = `Refining · ${value.completed} points`; }
  setStatus("working", `${value.completed} values evaluated · capacity ${value.capacity}`);
}
function completeStudyProgress(count: number): void { const host = element("study-progress"), progress = host.querySelector("progress")!; progress.value = 100; host.querySelector("span")!.textContent = `${count} points complete`; }

function setRunning(value: boolean, message?: string): void {
  running = value; element<HTMLButtonElement>("solve").disabled = value; document.querySelector<HTMLButtonElement>("#run-study")?.toggleAttribute("disabled", value); element<HTMLButtonElement>("cancel").disabled = !value;
  const progress = element<HTMLProgressElement>("solve-progress"); element("solve-progress-wrap").hidden = !value;
  if (value) { progress.value = 0; element("solve-stage").textContent = message ?? "Preparing…"; element("solve-detail").textContent = "Starting solver"; }
  if (message) setStatus("working", message);
}
function cancel(): void { if (running) { client.cancel(); setRunning(false); setStatus("neutral", "Run cancelled; worker restarted"); } }
function setStatus(tone: StatusTone, message: string): void { const node = element("status"); node.className = `status ${tone}`; node.textContent = message; element("status-dot").className = tone; }
function handleRunError(error: unknown): void { if (errorMessage(error) !== "Run cancelled") setStatus("error", errorMessage(error)); }
async function copyResult(): Promise<void> { await navigator.clipboard.writeText(JSON.stringify(currentResult ?? sensitivityResult ?? {}, null, 2)); setStatus("success", "Output copied"); }

function selectedEvaluation(): SensitivityResult["evaluations"][number] | null {
  if (!sensitivityResult?.evaluations.length) return null;
  if (sensitivitySelection === null) return sensitivityResult.evaluations[0];
  return sensitivityResult.evaluations.reduce((best, entry) => Math.abs(entry.value - sensitivitySelection!) < Math.abs(best.value - sensitivitySelection!) ? entry : best);
}

function editSelectedLayout(): void {
  const evaluation = selectedEvaluation(); if (!evaluation) return;
  const options = state.options, study = state.study;
  state = fromProblem(evaluation.problem); state.options = options; state.study = study;
  currentResult = structuredClone(evaluation.result); manualLayout = true; resultStale = false;
  history.clear(); projects.save(state); selection = currentResult.placements.length ? { kind: "placement", index: 0 } : null; selections = selection ? [selection] : [];
  renderPackingSidebar(); renderSensitivitySidebar(); updateHistoryButtons(); showPage("packing"); refreshPacking(true); updateDiagnostics(); element("workspace-summary").textContent = `${currentResult.packed_item_count} items · manual layout`;
  setStatus("neutral", "Sensitivity result opened as an editable layout");
}

function openExport(): void {
  const evaluation = selectedEvaluation();
  const result = page === "sensitivity" ? evaluation?.result ?? null : currentResult;
  element("export-options").innerHTML = exportOptionsHtml({ layout: !!result, sensitivity: !!sensitivityResult });
  element("export-options").querySelectorAll<HTMLButtonElement>("[data-export]").forEach((button) => button.addEventListener("click", () => void runExport(button.dataset.export!)));
  element<HTMLDialogElement>("export-dialog").showModal();
}

async function runExport(kind: string): Promise<void> {
  const evaluation = selectedEvaluation();
  const problem = page === "sensitivity" && evaluation ? evaluation.problem : toProblem(state);
  const result = page === "sensitivity" ? evaluation?.result ?? null : currentResult;
  const base = safeFilename(projects.active.name);
  if (kind === "problem-json") downloadText(`${base}-problem.json`, JSON.stringify(problem, null, 2), "application/json");
  else if (kind === "shapes-svg") downloadText(`${base}-shapes.svg`, shapesToSvg(problem), "image/svg+xml");
  else if (kind === "layout-svg" && result) downloadText(`${base}-layout.svg`, layoutToSvg(problem, result.placements), "image/svg+xml");
  else if (kind === "placements-csv" && result) downloadText(`${base}-placements.csv`, placementsCsv(result.placements), "text/csv");
  else if (kind === "solve-json" && result) downloadText(`${base}-solve.json`, JSON.stringify(result, null, 2), "application/json");
  else if (kind === "study-json" && sensitivityResult) downloadText(`${base}-sensitivity.json`, JSON.stringify(sensitivityResult, null, 2), "application/json");
  else if (kind === "layout-png" && result) await downloadLayoutPng(`${base}-layout.png`, problem, result.placements, { ...(page === "sensitivity" ? studyDisplay : display), viewSettings: state.viewSettings, customDimensions: page === "packing" ? state.dimensions : [] });
  else if (kind === "scene-png") { const blob = await cad.exportScenePng(); if (blob) downloadBlob(`${base}-scene.png`, blob); else throw new Error("Scene PNG could not be rendered"); }
  else return;
  setStatus("success", `${kind.replaceAll("-", " ")} exported`);
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme; projects.setTheme(theme);
  element("theme-toggle").textContent = theme === "dark" ? "☀" : "☾"; element("theme-toggle-study").textContent = theme === "dark" ? "☀" : "☾";
  requestAnimationFrame(() => refreshCurrentPage());
}
function bindOverlay(prefix: string, target: { dimensions: boolean; clearance: boolean }): void {
  element<HTMLInputElement>(`${prefix}-dimensions`).addEventListener("change", (event) => { target.dimensions = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
  element<HTMLInputElement>(`${prefix}-clearance`).addEventListener("change", (event) => { target.clearance = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
}
function updateHistoryButtons(): void { element<HTMLButtonElement>("undo").disabled = !history.canUndo; element<HTMLButtonElement>("redo").disabled = !history.canRedo; }
function normalizeSelection(value: CadSelection | null): CadSelection | null {
  if (value?.kind === "auto-dimension") return value;
  if (!value || value.kind === "placement") return state.containerParts.length ? { kind: "container", index: 0 } : null;
  const length = value.kind === "container" ? state.containerParts.length : value.kind === "exclusion" ? state.exclusions.length : value.kind === "item" ? state.items.length
    : value.kind === "guide" ? state.drafting.guides.length : value.kind === "drafting" ? state.drafting.shapes.length : value.kind === "dimension" ? state.dimensions.length : value.kind === "text" ? state.drafting.texts.length : state.drafting.traceImages.length;
  return value.index < length ? value : length ? { kind: value.kind, index: 0 } : null;
}
function isEditingText(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest("input, textarea, select, [contenteditable='true']");
}
function parseSelection(value: string): CadSelection { const [kind, index] = value.split(":"); return { kind: kind as CadSelection["kind"], index: Number(index) } as CadSelection; }
function itemIndexForParameter(key: string): number { const [kind, id] = key.split(":"); return kind.startsWith("part_") || kind.startsWith("item_") ? state.items.findIndex((item) => item.id === id) : -1; }
function editStudySource(): void {
  const [kind, id, rawIndex] = state.study.parameterKey.split(":");
  let next: CadSelection | null = null; let partIndex = Number(rawIndex) || 0;
  if (kind.startsWith("part_") || kind.startsWith("item_")) { const index = state.items.findIndex((item) => item.id === id); if (index >= 0) next = { kind: "item", index, partIndex }; }
  else if (kind.startsWith("container_part_")) { const index = state.containerParts.findIndex((entry) => entry.id === id); if (index >= 0) next = { kind: "container", index }; }
  else if (kind === "container_width" || kind === "container_height") { const index = state.containerParts.findIndex((entry) => entry.operation === "add"); if (index >= 0) next = { kind: "container", index }; }
  else if (kind === "exclusion_scale") { const index = state.exclusions.findIndex((entry) => entry.id === id); if (index >= 0) next = { kind: "exclusion", index, partIndex: 0 }; }
  showPage("packing");
  if (next) { selectCad(next, partIndex); display.dimensions = true; display.clearance = true; syncWorkspaceOverlays(); requestAnimationFrame(() => cad.focusSelection()); }
  else { display.clearance = true; syncWorkspaceOverlays(); setStatus("neutral", "Clearance constraints are highlighted in the workspace"); }
}

function syncWorkspaceOverlays(): void {
  state.viewSettings.showDimensions = display.dimensions; state.viewSettings.showClearance = display.clearance; projects.save(state);
  (["dimensions", "clearance"] as const).forEach((key) => {
    const button = element<HTMLButtonElement>(key === "dimensions" ? "toggle-dimensions" : "toggle-clearance");
    button.classList.toggle("active", display[key]); button.setAttribute("aria-pressed", String(display[key]));
  });
  cad.setOverlays(display.dimensions, display.clearance);
}
function applySidebarTooltips(sidebar: HTMLElement): void {
  const help: Record<string, string> = {
    "Rotation search": "Adaptive searches any angle in the range; fixed angles restrict the solver to the listed orientations.",
    "Coupling": "Independent lets copies rotate separately; shared uses one orientation for every copy of this shape.",
    "Boolean operation": "Add contributes usable container material; subtract removes a cut-out.",
    "Construction": "Reassign this primitive between container material, a packable shape, or an exclusion without changing its position.",
    "Snap to": "Create a live relationship to another part, or choose free position to detach while preserving location.",
    "Own anchor": "The point on this part that attaches to its target.", "Target anchor": "The attachment point on the target part.",
    "Quality": "Controls the solver's search-depth preset.", "Baseline only": "Stops after the initial deterministic placement pass.",
  };
  sidebar.querySelectorAll<HTMLLabelElement>("label").forEach((label) => {
    const key = Object.keys(help).find((candidate) => label.textContent?.trim().startsWith(candidate)); if (key && !label.title) label.title = help[key];
  });
}
function draftingEntityNumber(label: string, entity: "guide" | "trace", index: number, field: string, value: number, step = .1): string { return `<label>${label}<input type="number" value="${format(value)}" step="${step}" data-${entity}-field="${field}" data-entity-index="${index}"></label>`; }
function bindFixedPlacements(sidebar: HTMLElement): void {
  sidebar.querySelector("#add-fixed-inline")?.addEventListener("click", () => mutate(() => {
    const item = state.items[0]; if (!item) return;
    const points = resolveGeometry(toProblem(state)).container.flat();
    const center = points.length ? { x: Math.min(...points.map((point) => point.x)) * .75 + Math.max(...points.map((point) => point.x)) * .25, y: Math.min(...points.map((point) => point.y)) * .75 + Math.max(...points.map((point) => point.y)) * .25 } : { x: 0, y: 0 };
    state.fixedPlacements.push({ item_id: item.id, x: center.x, y: center.y, rotation_deg: 0 });
  }));
  sidebar.querySelectorAll<HTMLElement>("[data-fixed-row]").forEach((row) => {
    const index = Number(row.dataset.fixedRow);
    row.querySelector<HTMLSelectElement>("select")?.addEventListener("change", (event) => mutate(() => { state.fixedPlacements[index].item_id = (event.target as HTMLSelectElement).value; }));
    row.querySelectorAll<HTMLInputElement>("[data-fixed-field]").forEach((input) => input.addEventListener("change", () => mutate(() => {
      setField(state.fixedPlacements[index], input.dataset.fixedField!, Number(input.value));
    })));
    row.querySelector("[data-delete-fixed]")?.addEventListener("click", () => mutate(() => { state.fixedPlacements.splice(index, 1); }));
  });
}
function placeAtContainerCenter(part: PrimitiveEditor): void {
  const base = state.containerParts.find((entry) => entry.operation === "add")?.primitive;
  if (base) { part.x = base.x; part.y = base.y; }
}
function uniqueId(prefix: string, ids: string[]): string {
  if (!ids.includes(prefix)) return prefix;
  let suffix = 2; while (ids.includes(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}
function convertPrimitive(source: PrimitiveEditor, kind: PrimitiveEditor["kind"]): PrimitiveEditor {
  if (source.kind === kind) return source;
  const next = makePrimitive(kind);
  next.id = source.id; next.x = source.x; next.y = source.y; next.rotation = source.rotation; next.color = source.color;
  if (source.snap) next.snap = structuredClone(source.snap);
  const points = shapePoints(primitiveShape(source));
  if (points.length) {
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
    if (next.kind === "rectangle") { next.width = Math.max(.05, width); next.height = Math.max(.05, height); }
    else if (next.kind === "triangle") { next.base = Math.max(.05, width); next.height = Math.max(.05, height); }
    else if (next.kind === "circle") next.radius = Math.max(.025, Math.max(width, height) / 2);
  }
  return next;
}
function replaceSelectedPrimitive(next: PrimitiveEditor): void {
  if (!selection || selection.kind === "placement") return;
  if (selection.kind === "container") state.containerParts[selection.index].primitive = next;
  else if (selection.kind === "exclusion") state.exclusions[selection.index].parts[selection.partIndex ?? selectedPartIndex] = next;
  else if (selection.kind === "item") state.items[selection.index].parts[selection.partIndex ?? selectedPartIndex] = next;
}
function setField(target: object, field: string, value: unknown): void { (target as Record<string, unknown>)[field] = value; }
function format(value: number): string { return formatNumber(value); }
function clampNumber(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
