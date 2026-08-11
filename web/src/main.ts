import "./style.css";
import { CadWorkspace, type CadSelection } from "./cad-workspace";
import { initGeometryResolver } from "./geometry-resolver";
import { SolverClient } from "./solver-client";
import { cloneItemAtParameter, fromProblem, makePrimitive, parsePointText, primitiveShape, resolveEditorTranslations, shapePoints, toProblem, transformPoint } from "./problem";
import { renderLayout, renderPolygonsPreview, renderSensitivity, sensitivityValueAt } from "./renderer";
import { resolveGeometry } from "./geometry-resolver";
import { WorkspaceHistory, WorkspaceStore } from "./workspace-store";
import type {
  AnchorName, EditorItem, EditorState, PackingProblem, ParameterPath, Placement, PrimitiveEditor, SensitivityProgress,
  SensitivityResult, SensitivityStudy, SolveProgress, SolveResult,
} from "./types";

type PageName = "packing" | "sensitivity";
type StatusTone = "neutral" | "working" | "success" | "error";
const ANCHORS: AnchorName[] = ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"];

await initGeometryResolver();

const root = document.querySelector<HTMLDivElement>("#app")!;
const client = new SolverClient();
const projects = new WorkspaceStore();
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
let placementClipboard: Placement[] = [];
let cad: CadWorkspace;
let running = false;
let manualLayout = false;
let resultStale = false;
const display = { dimensions: false, clearance: false };
const studyDisplay = { dimensions: false, clearance: false };

root.innerHTML = `
  <section id="packing-page" class="app-page">
    <div id="cad-shell" class="cad-shell">
      <aside id="problem-panel" class="problem-panel">
        <header class="studio-brand">
          <div class="brand-lockup"><div><strong>OpenLayout</strong><small>2D packing studio</small></div></div>
          <div class="project-quick"><select id="quick-project" aria-label="Switch project"></select><button id="open-projects" class="project-chip" aria-label="Edit projects" title="Manage, import, and export projects"><span id="active-project-name" class="sr-only"></span>•••</button></div>
        </header>
        <div id="packing-sidebar" class="problem-panel-scroll"></div>
        <footer class="run-dock">
          <div class="run-buttons"><button id="validate" class="button ghost">Validate</button><button id="cancel" class="button danger" disabled>Stop</button><button id="solve" class="button primary">Run packing</button></div>
          <div id="solve-progress-wrap" class="solve-progress-wrap" hidden><div><strong id="solve-stage">Preparing…</strong><span id="solve-detail"></span></div><progress id="solve-progress" max="100" value="0" aria-label="Packing solve progress"></progress></div>
        </footer>
      </aside>
      <main class="cad-stage-shell">
        <div class="cad-toolbar" aria-label="Workspace tools">
          <button id="sidebar-toggle" class="tool-button" aria-label="Hide problem panel" title="Hide problem panel">☰</button>
          <span class="tool-divider"></span>
          <button id="select-tool" class="tool-button active" aria-label="Select tool">↖ <span>Select</span></button>
          <button id="fit-view" class="tool-button" aria-label="Fit workspace">⌗ <span>Fit</span></button>
          <button id="focus-selection" class="tool-button" aria-label="Focus selection" title="Zoom to selected geometry (double-click)">◎ <span>Focus</span></button>
          <button id="zoom-out" class="tool-button" aria-label="Zoom out">−</button>
          <button id="zoom-in" class="tool-button" aria-label="Zoom in">＋</button>
          <span class="tool-divider"></span>
          <button class="tool-button geometry-action" data-toolbar-shape="rectangle" aria-label="Add rectangle" title="Add rectangle to the selected object">▭ <span>Rectangle</span></button>
          <button class="tool-button geometry-action" data-toolbar-shape="circle" aria-label="Add circle" title="Add circle to the selected object">○ <span>Circle</span></button>
          <select id="toolbar-add-shape" class="tool-select" aria-label="Add other geometry"><option value="">＋ More</option><option value="triangle">Triangle</option><option value="polygon">Polygon</option><option value="bezier">Bézier</option></select>
          <label class="toolbar-color" title="Selected part colour"><span>Colour</span><input id="toolbar-part-color" type="color" aria-label="Selected part colour" value="#51c6a4"></label>
          <button id="join-material" class="tool-button" aria-label="Unify selected material" title="Snap this region into the additive material union">⌁ <span>Unify</span></button>
          <button id="delete-selection" class="tool-button danger-tool" aria-label="Delete selection" title="Delete selected part or object">⌫</button>
          <span class="tool-divider"></span>
          <button id="toggle-dimensions" class="tool-button compact-overlay" aria-label="Dimensions" aria-pressed="false" title="Show or hide drawing dimensions">↔<span>Dimensions</span></button>
          <button id="toggle-clearance" class="tool-button compact-overlay" aria-label="Constraints" aria-pressed="false" title="Show or hide clearance boundaries">◌<span>Constraints</span></button>
          <button id="respect-manual-constraints" class="tool-button compact-overlay active" aria-label="Toggle manual collision guard" aria-pressed="true" title="Move to the closest feasible position while respecting boundaries, clearances, overlaps, and fixed placements">♢<span>Collision guard</span></button>
          <span class="tool-spacer"></span>
          <button id="undo" class="tool-button" aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled>↶</button>
          <button id="redo" class="tool-button" aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled>↷</button>
          <button id="open-diagnostics" class="tool-button">Diagnostics</button>
          <button id="open-sensitivity" class="tool-button">Sensitivity</button>
          <button id="theme-toggle" class="tool-button" aria-label="Toggle theme">◐</button>
        </div>
        <svg id="cad-canvas" class="cad-canvas" tabindex="0" aria-label="Interactive packing workspace"></svg>
        <div class="cad-help">Drag empty space to pan · Ctrl/⌘-drag box-selects · Ctrl/⌘-click adds selection · cyan grips edit · snap points appear only while dragging a snappable part</div>
        <div class="workspace-state"><span id="status-dot"></span><span id="status" class="status neutral">Saved locally</span><strong id="workspace-summary">Problem definition</strong></div>
        <div id="cad-context-menu" class="cad-context-menu" hidden><button data-context-action="focus">Focus selection</button><button data-context-action="copy">Copy</button><button data-context-action="duplicate">Duplicate</button><button data-context-action="fixed">Toggle fixed</button><button data-context-action="delete" class="danger-text">Delete</button></div>
      </main>
    </div>
  </section>

  <section id="sensitivity-page" class="app-page" hidden>
    <div class="sensitivity-header"><button id="back-to-workspace" class="button ghost">← Workspace</button><div><small>SENSITIVITY</small><strong>Capacity study</strong></div><span class="sensitivity-header-spacer"></span><button id="theme-toggle-study" class="tool-button" aria-label="Toggle theme from sensitivity">◐</button></div>
    <div class="page-shell sensitivity-shell">
      <aside id="sensitivity-sidebar" class="side-panel"></aside>
      <main class="sensitivity-content">
        <section class="panel study-preview-panel">
          <div class="panel-heading"><div><small>GEOMETRY PREVIEW</small><h1>Study steps and extremes</h1></div>${overlayToggles("study")}</div>
          <div id="study-shape-preview" class="sensitivity-steps"></div>
        </section>
        <section class="study-results-grid">
          <div class="panel sensitivity-panel">
            <div class="panel-heading"><div><small>PARAMETER STUDY</small><h2>Capacity transitions</h2></div><div id="study-progress" class="study-progress" hidden><progress max="100" value="0"></progress><span>Preparing…</span></div></div>
            <div id="sensitivity-scroll" class="sensitivity-scroll"><canvas id="sensitivity-canvas" tabindex="0" aria-label="Sensitivity capacity chart"></canvas></div>
            <div id="transitions" class="transition-list"></div>
          </div>
          <div class="panel sensitivity-layout-panel">
            <div class="panel-heading"><div><small>SELECTED RESULT</small><h2 id="sensitivity-layout-title">No result selected</h2></div><div id="sensitivity-layout-id" class="layout-id">—</div></div>
            <canvas id="sensitivity-layout-canvas" aria-label="Selected sensitivity layout"></canvas>
            <div id="sensitivity-metrics" class="metrics"></div>
          </div>
        </section>
      </main>
    </div>
  </section>

  <dialog id="project-dialog" class="studio-dialog"><form method="dialog"><header><div><small>LOCAL WORKSPACE</small><h2>Projects</h2></div><button class="dialog-close" value="cancel" aria-label="Close projects">×</button></header><div id="project-dialog-body"></div></form></dialog>
  <dialog id="diagnostics-dialog" class="studio-dialog diagnostics-dialog"><form method="dialog"><header><div><small>ENGINE OUTPUT</small><h2>Diagnostics & metrics</h2></div><button class="dialog-close" value="cancel" aria-label="Close diagnostics">×</button></header><div id="diagnostics" class="diagnostics"><p>Run a solve to inspect validation and search statistics.</p></div><footer><button id="copy-result" type="button" class="button ghost">Copy result JSON</button><button class="button" value="cancel">Done</button></footer></form></dialog>`;

applyTheme(projects.theme);
cad = new CadWorkspace(document.getElementById("cad-canvas") as unknown as SVGSVGElement, state, toProblem(state), {
  onSelect: selectCad,
  onMarquee: selectMarquee,
  onDefinitionChange: definitionChanged,
  onPlacementChange: placementChanged,
  onPlacementRejected: () => setStatus("error", "No feasible position was found near that location"),
  onPlacementAdjusted: () => setStatus("neutral", "Moved to the closest feasible position near the pointer"),
});
bindShell();
renderPackingSidebar();
renderSensitivitySidebar();
updateHistoryButtons();

function bindShell(): void {
  element("open-projects").addEventListener("click", openProjects);
  element<HTMLSelectElement>("quick-project").addEventListener("change", (event) => { projects.save(state); loadProject((event.target as HTMLSelectElement).value); });
  element("open-diagnostics").addEventListener("click", () => element<HTMLDialogElement>("diagnostics-dialog").showModal());
  element("open-sensitivity").addEventListener("click", () => showPage("sensitivity"));
  element("back-to-workspace").addEventListener("click", () => showPage("packing"));
  element("sidebar-toggle").addEventListener("click", toggleSidebar);
  element("fit-view").addEventListener("click", () => cad.fit());
  element("focus-selection").addEventListener("click", () => cad.focusSelection());
  element("zoom-in").addEventListener("click", () => cad.zoom(.8));
  element("zoom-out").addEventListener("click", () => cad.zoom(1.25));
  document.querySelectorAll<HTMLButtonElement>("[data-toolbar-shape]").forEach((button) => button.addEventListener("click", () => addGeometry(button.dataset.toolbarShape as PrimitiveEditor["kind"])));
  element<HTMLSelectElement>("toolbar-add-shape").addEventListener("change", (event) => { const input = event.target as HTMLSelectElement; if (input.value) addGeometry(input.value as PrimitiveEditor["kind"]); input.value = ""; });
  element<HTMLInputElement>("toolbar-part-color").addEventListener("input", (event) => mutate(() => {
    const color = (event.target as HTMLInputElement).value;
    selectedPrimitivesForColor().forEach((part) => { part.color = color; });
  }));
  element("join-material").addEventListener("click", joinSelectedMaterial);
  element("delete-selection").addEventListener("click", deleteToolbarSelection);
  element("toggle-dimensions").addEventListener("click", () => toggleOverlay("dimensions"));
  element("toggle-clearance").addEventListener("click", () => toggleOverlay("clearance"));
  element("respect-manual-constraints").addEventListener("click", () => {
    const button = element<HTMLButtonElement>("respect-manual-constraints"), enabled = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(enabled)); button.classList.toggle("active", enabled); cad.setRespectFixed(enabled);
    setStatus("neutral", enabled ? "Manual edits will respect boundaries, clearances, overlaps, and fixed placements" : "Constraint checks disabled for manual edits");
  });
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
    if (target) selectCad({ kind: target.dataset.cadKind as CadSelection["kind"], index: Number(target.dataset.cadIndex), ...(target.dataset.cadPart === undefined ? {} : { partIndex: Number(target.dataset.cadPart) }) } as CadSelection, target.dataset.cadPart === undefined ? undefined : Number(target.dataset.cadPart));
    contextMenu.style.left = `${event.clientX}px`; contextMenu.style.top = `${event.clientY}px`; contextMenu.hidden = false;
    contextMenu.querySelector<HTMLButtonElement>('[data-context-action="fixed"]')!.hidden = selection?.kind !== "placement";
  });
  document.addEventListener("pointerdown", (event) => { if (!(event.target as Element).closest("#cad-context-menu")) contextMenu.hidden = true; });
  contextMenu.querySelectorAll<HTMLButtonElement>("[data-context-action]").forEach((button) => button.addEventListener("click", () => {
    contextMenu.hidden = true;
    if (button.dataset.contextAction === "focus") cad.focusSelection();
    else if (button.dataset.contextAction === "copy") copySelectedItems();
    else if (button.dataset.contextAction === "duplicate") { copySelectedItems(); pasteItems(); }
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
    if ((event.key === "Delete" || event.key === "Backspace") && !isEditingText(event.target)) {
      event.preventDefault(); deleteToolbarSelection(); return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === "c" && !isEditingText(event.target)) { event.preventDefault(); copySelectedItems(); return; }
    if (event.key.toLowerCase() === "v" && !isEditingText(event.target)) { event.preventDefault(); pasteItems(); return; }
    if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    if (event.key.toLowerCase() === "s") { event.preventDefault(); projects.save(state); setStatus("success", "Project saved on this device"); }
  });
}

function toggleTheme(): void { applyTheme(projects.theme === "dark" ? "light" : "dark"); }

function toggleSidebar(): void {
  const hidden = element("cad-shell").classList.toggle("panel-hidden");
  const button = element<HTMLButtonElement>("sidebar-toggle");
  button.setAttribute("aria-label", hidden ? "Show problem panel" : "Hide problem panel");
  button.title = hidden ? "Show problem panel" : "Hide problem panel";
  requestAnimationFrame(() => cad.fit());
}

function toggleOverlay(key: keyof typeof display): void {
  display[key] = !display[key];
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
  sidebar.innerHTML = `
    <section class="problem-section entity-section">
      <div class="section-title"><div><small>PROBLEM</small><h2>Drawing objects</h2></div></div>
      <div class="entity-group"><span>Container</span>${state.containerParts.map((entry, index) => entityButton("container", index, entry.id, entry.operation === "add" ? "Material" : "Cut-out")).join("")}</div>
      <div class="entity-group"><span>Exclusions</span>${state.exclusions.map((entry, index) => entityButton("exclusion", index, entry.id, `${format(entry.clearance)} clearance`)).join("") || '<p class="empty-inline">None</p>'}</div>
      <div class="entity-group"><span>Packable shapes</span>${state.items.map((item, index) => entityButton("item", index, item.id, `${item.quantity} requested`)).join("")}</div>
      <div class="object-add-row"><button data-add-object="item">+ Item</button><button data-add-object="material">+ Material</button><button data-add-object="cutout">+ Cut-out</button><button data-add-object="exclusion">+ Exclusion</button></div>
    </section>
    <section id="selection-inspector" class="problem-section inspector-section">${selectionInspector()}</section>
    <details class="problem-section settings-section" open><summary>Clearances <span>Constraints</span></summary><div class="details-body field-grid three">
      ${numberField("Item ↔ item", "clearance", "item_to_item", state.clearance.item_to_item, .05)}
      ${numberField("Boundary", "clearance", "item_to_boundary", state.clearance.item_to_boundary, .05)}
      ${numberField("Exclusion", "clearance", "item_to_exclusion", state.clearance.item_to_exclusion, .05)}
    </div></details>
    <details class="problem-section settings-section"><summary>Fixed placements <span>${state.fixedPlacements.length || "None"}</span></summary><div class="details-body">${fixedPlacementsHtml()}</div></details>
    <details class="problem-section settings-section"><summary>Solver <span>${humanStatus(state.options.quality)}</span></summary><div class="details-body field-grid two">
      ${numberField("Seed", "option", "seed", state.options.seed, 1)}${numberField("Base iterations", "option", "max_iterations", state.options.max_iterations, 1000)}
      ${numberField("Grid step", "option", "grid_step", state.options.grid_step, .1)}${numberField("Restarts", "option", "restarts", state.options.restarts, 1)}
      <label class="wide">Quality<select data-pack-scope="option" data-field="quality"><option value="fast" ${state.options.quality === "fast" ? "selected" : ""}>Fast preview</option><option value="balanced" ${state.options.quality === "balanced" ? "selected" : ""}>Balanced</option><option value="thorough" ${state.options.quality === "thorough" ? "selected" : ""}>Thorough</option></select></label>
      <label class="wide checkbox-field"><input type="checkbox" data-pack-scope="option" data-field="baseline_only" ${state.options.baseline_only ? "checked" : ""}> Baseline only · quick validation</label>
    </div></details>`;
  applySidebarTooltips(sidebar);
  sidebar.querySelectorAll<HTMLElement>("[data-cad-select]").forEach((node) => node.addEventListener("click", (event) => {
    const next = parseSelection(node.dataset.cadSelect!); selectCad(next, undefined, event.ctrlKey || event.metaKey);
  }));
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
  updateToolbarState();
}

function entityButton(kind: "container" | "exclusion" | "item", index: number, name: string, meta: string): string {
  const key = `${kind}:${index}`;
  const selected = selections.some((entry) => entry.kind === kind && entry.index === index);
  return `<button class="entity-row ${selected ? "selected" : ""}" data-cad-select="${key}" title="Select ${kind === "item" ? "this packable shape definition" : kind === "exclusion" ? "this keep-out region" : "this container region"}"><canvas data-entity-preview="${key}" aria-hidden="true"></canvas><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(meta)}</small></span></button>`;
}

function selectionInspector(): string {
  if (selections.length > 1) return `<div class="inspector-empty"><small>MULTI-SELECTION</small><strong>${selections.length} ${selections.every(isPartSelection) ? "parts" : "objects"} selected</strong><p>Drag any selected part to move the group, use Colour to recolour them, or Delete to remove exactly the selected geometry.</p></div>`;
  if (!selection) return `<div class="inspector-empty"><small>INSPECTOR</small><strong>Nothing selected</strong><p>Click a container region, exclusion, shape definition, or packed item in the drawing.</p></div>`;
  if (selection.kind === "placement") {
    const placement = currentResult?.placements[selection.index];
    if (!placement) return `<div class="inspector-empty"><strong>Placement unavailable</strong></div>`;
    return `<div class="inspector-heading"><div><small>PACKED ITEM ${selection.index + 1}</small><h2>${escapeHtml(placement.item_id)}</h2></div><span class="selection-badge">Manual edit</span></div>
      <div class="field-grid three">${placementField("X", "x", placement.x, .1)}${placementField("Y", "y", placement.y, .1)}${placementField("Rotation°", "rotation_deg", placement.rotation_deg, 1)}</div>
      <p class="hint">Drag this item directly in the workspace or use the amber rotation handle. Manual changes are retained in this result but are not solver-validated.</p>
      <button id="reset-layout" class="button ghost full">Discard solved layout</button>`;
  }
  if (selection.kind === "container") {
    const entry = state.containerParts[selection.index];
    if (!entry) return emptyConstructionHtml("Container is empty", "Add material or a cut-out from the object bar.");
    return `<div class="inspector-heading"><div><small>CONTAINER REGION</small><h2>${escapeHtml(entry.id)}</h2></div><span class="selection-badge">${entry.operation}</span></div>
      <div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(entry.id)}"></label><label>Boolean operation<select data-object-field="operation"><option value="add" ${entry.operation === "add" ? "selected" : ""}>Add material</option><option value="subtract" ${entry.operation === "subtract" ? "selected" : ""}>Subtract cut-out</option></select></label></div>
      ${primitiveEditorHtml(entry.primitive)}
      ${snapEditorHtml(state.containerParts.map((region) => region.primitive), entry.primitive, "REGION CONNECTION")}
      <p class="hint">Drag the region in the drawing to move it, use the amber handle to rotate it, or enter exact values here.</p>
      <button data-delete-object class="button danger full">Delete region</button>`;
  }
  if (selection.kind === "exclusion") {
    const entry = state.exclusions[selection.index];
    if (!entry) return emptyConstructionHtml("Exclusion unavailable", "Select or add an exclusion.");
    selectedPartIndex = Math.min(selectedPartIndex, Math.max(0, entry.parts.length - 1));
    const part = entry.parts[selectedPartIndex];
    return `<div class="inspector-heading"><div><small>EXCLUSION</small><h2>${escapeHtml(entry.id)}</h2></div><span class="selection-badge">${format(entry.clearance)} clear</span></div>
      <div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(entry.id)}"></label><label>Clearance<input type="number" step=".05" data-object-field="clearance" value="${format(entry.clearance)}"></label></div>
      ${constructionEditorHtml(entry.parts, part, "EXCLUSION PART")}
      <div class="inline-actions"><button data-delete-part class="button danger" ${part ? "" : "disabled"}>Delete part</button><button data-delete-object class="button danger">Delete exclusion</button></div>
      <p class="hint">All parts form one unified exclusion. Drag, rotate, or resize the complete construction in the drawing.</p>`;
  }
  const item = state.items[selection.index];
  if (!item) return emptyConstructionHtml("Shape unavailable", "Select or add a packable shape.");
  selectedPartIndex = Math.min(selectedPartIndex, Math.max(0, item.parts.length - 1));
  const part = item.parts[selectedPartIndex];
  return `<div class="inspector-heading"><div><small>PACKABLE SHAPE</small><h2>${escapeHtml(item.id)}</h2></div><span class="selection-badge">${item.quantity} requested</span></div>
    <div class="field-grid two"><label>ID<input data-object-field="id" value="${escapeHtml(item.id)}"></label><label>Quantity<input type="number" step="1" data-object-field="quantity" value="${item.quantity}"></label><label>Rotation search<select data-object-field="rotationMode"><option value="continuous" ${item.rotationMode === "continuous" ? "selected" : ""}>Adaptive</option><option value="discrete" ${item.rotationMode === "discrete" ? "selected" : ""}>Fixed angles</option></select></label><label>Coupling<select data-object-field="rotationCoupling"><option value="independent" ${item.rotationCoupling === "independent" ? "selected" : ""}>Independent</option><option value="shared_per_item" ${item.rotationCoupling === "shared_per_item" ? "selected" : ""}>Shared</option></select></label>${item.rotationMode === "continuous" ? objectNumber("Minimum°", "minRotation", item.minRotation, 1) + objectNumber("Maximum°", "maxRotation", item.maxRotation, 1) : `<label class="wide">Angles<input data-object-field="rotations" value="${escapeHtml(item.rotations)}"></label>`}</div>
    ${constructionEditorHtml(item.parts, part, "PART CONSTRAINT")}
    <div class="inline-actions"><button data-delete-part class="button danger" ${part ? "" : "disabled"}>Delete part</button><button data-delete-object class="button danger">Delete item</button></div>
    <p class="hint">Drag the complete shape to move it. The top handle rotates the whole item; the corner handle scales every part and constraint together.</p>`;
}

function constructionEditorHtml(parts: PrimitiveEditor[], part: PrimitiveEditor | undefined, snapTitle: string): string {
  return `<div class="inline-part-heading"><label>Editing part<select id="item-part-select" ${part ? "" : "disabled"}>${parts.map((entry, index) => `<option value="${index}" ${index === selectedPartIndex ? "selected" : ""}>${escapeHtml(entry.id)} · ${entry.kind}</option>`).join("")}</select></label><span>${part ? `${selectedPartIndex + 1}/${parts.length}` : "0/0"}</span></div>
    ${part ? primitiveEditorHtml(part) + snapEditorHtml(parts, part, snapTitle) : '<div class="inspector-empty compact"><strong>Empty construction</strong><p>Add a primitive below to continue editing.</p></div>'}
    <div class="part-add-row">${(["rectangle", "triangle", "circle", "polygon", "bezier"] as const).map((kind) => `<button data-add-part="${kind}">+ ${kind}</button>`).join("")}</div>`;
}

function emptyConstructionHtml(title: string, message: string): string {
  return `<div class="inspector-empty"><small>INSPECTOR</small><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

function primitiveEditorHtml(part: PrimitiveEditor): string {
  const dimensions = part.kind === "rectangle" ? primitiveNumber("Width", "width", part.width) + primitiveNumber("Height", "height", part.height)
    : part.kind === "triangle" ? primitiveNumber("Base", "base", part.base) + primitiveNumber("Height", "height", part.height)
      : part.kind === "circle" ? primitiveNumber("Radius", "radius", part.radius) + primitiveNumber("Segments", "segments", part.segments, 1)
        : part.kind === "polygon" ? `<label class="wide">Vertices<textarea rows="4" data-primitive-points>${part.vertices.map((point) => `${format(point.x)}, ${format(point.y)}`).join("\n")}</textarea></label>`
          : `${primitiveNumber("Curve segments", "segments", part.segments, 1)}<label class="wide">Bézier knots<textarea rows="5" data-bezier-knots>${escapeHtml(JSON.stringify(part.knots, null, 2))}</textarea></label>`;
  return `<div class="primitive-editor"><div class="primitive-editor-title"><small>PART GEOMETRY</small><span>${escapeHtml(part.id)}${part.snap ? " · snapped" : ""}</span></div><div class="field-grid two"><label class="wide">Shape type<select data-primitive-kind>${(["rectangle", "triangle", "circle", "polygon", "bezier"] as const).map((kind) => `<option value="${kind}" ${part.kind === kind ? "selected" : ""}>${humanStatus(kind)}</option>`).join("")}</select></label>${dimensions}${primitiveNumber("X", "x", part.x)}${primitiveNumber("Y", "y", part.y)}${primitiveNumber("Rotation°", "rotation", part.rotation, 1)}<label>Colour<input type="color" data-primitive-color value="${partColor(part)}"></label><label class="wide">Construction<select data-part-owner>${partOwnerOptions()}</select></label></div></div>`;
}

function snapEditorHtml(parts: PrimitiveEditor[], part: PrimitiveEditor, title: string): string {
  const targets = parts.filter((entry) => entry.id !== part.id && !dependsOn(parts, entry.id, part.id));
  return `<div class="inline-snap"><div class="primitive-editor-title"><small>${title}</small><span>${part.snap ? "Anchored" : "Free"}</span></div>
    <label>Snap to<select data-snap-target><option value="">Free position</option>${targets.map((target) => `<option value="${escapeHtml(target.id)}" ${part.snap?.targetId === target.id ? "selected" : ""}>${escapeHtml(target.id)}</option>`).join("")}</select></label>
    ${part.snap ? `<div class="field-grid two"><label>Own anchor<select data-snap-anchor="ownAnchor">${anchorOptions(part.snap.ownAnchor)}</select></label><label>Target anchor<select data-snap-anchor="targetAnchor">${anchorOptions(part.snap.targetAnchor)}</select></label>${snapNumber("Offset X", "x", part.snap.offset.x)}${snapNumber("Offset Y", "y", part.snap.offset.y)}</div><button id="detach-inline-snap" class="button ghost full">Detach at current position</button>` : '<p class="hint">Choose another part to create a live anchor relationship.</p>'}
  </div>`;
}

function bindInlineInspector(sidebar: HTMLElement): void {
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
  })));
  sidebar.querySelector("[data-delete-part]")?.addEventListener("click", () => mutate(() => {
    deleteSelectedPart();
  }));
  sidebar.querySelector("[data-delete-object]")?.addEventListener("click", deleteSelectedObject);
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
  if (!selection || selection.kind === "placement") return null;
  if (selection.kind === "container") return state.containerParts[selection.index];
  if (selection.kind === "exclusion") return state.exclusions[selection.index];
  return state.items[selection.index];
}

function selectedPrimitive(): PrimitiveEditor | null {
  if (!selection || selection.kind === "placement") return null;
  if (selection.kind === "container") return state.containerParts[selection.index]?.primitive ?? null;
  if (selection.kind === "exclusion") return state.exclusions[selection.index]?.parts[selection.partIndex ?? selectedPartIndex] ?? null;
  return state.items[selection.index]?.parts[selection.partIndex ?? selectedPartIndex] ?? null;
}

function selectedPrimitivesForColor(): PrimitiveEditor[] {
  if (selections.length <= 1) return selectedPrimitive() ? [selectedPrimitive()!] : [];
  const parts: PrimitiveEditor[] = [];
  selections.forEach((entry) => {
    if (entry.kind === "container") {
      const primitive = state.containerParts[entry.index]?.primitive; if (primitive) parts.push(primitive);
    } else if (entry.kind === "exclusion") {
      const values = state.exclusions[entry.index]?.parts ?? []; parts.push(...(entry.partIndex === undefined ? values : values[entry.partIndex] ? [values[entry.partIndex]] : []));
    } else if (entry.kind === "item") {
      const values = state.items[entry.index]?.parts ?? []; parts.push(...(entry.partIndex === undefined ? values : values[entry.partIndex] ? [values[entry.partIndex]] : []));
    } else {
      const itemId = currentResult?.placements[entry.index]?.item_id;
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (item) parts.push(...item.parts);
    }
  });
  return [...new Set(parts)];
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
    if (selection?.kind === "item") {
      const item = state.items[selection.index], target = item.parts[selectedPartIndex] ?? item.parts[0];
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      item.parts.push(primitive); selectedPartIndex = item.parts.length - 1;
      return;
    }
    if (selection?.kind === "container") {
      const selected = state.containerParts[selection.index], target = selected?.primitive;
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      state.containerParts.push({ id: uniqueId(selected?.operation === "subtract" ? "cutout" : "material", state.containerParts.map((entry) => entry.id)), operation: selected?.operation ?? "add", primitive });
      selection = { kind: "container", index: state.containerParts.length - 1 }; selectedPartIndex = 0;
      return;
    }
    if (selection?.kind === "exclusion") {
      const parts = state.exclusions[selection.index].parts, target = parts[selectedPartIndex] ?? parts[0];
      if (target) primitive.snap = { targetId: target.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
      parts.push(primitive); selectedPartIndex = parts.length - 1;
      return;
    }
    placeAtContainerCenter(primitive);
    state.containerParts.push({ id: uniqueId("material", state.containerParts.map((entry) => entry.id)), operation: "add", primitive });
    selection = { kind: "container", index: state.containerParts.length - 1 }; selectedPartIndex = 0;
  });
  selections = selection ? [selection] : [];
  refreshPacking(true);
}

function joinSelectedMaterial(): void {
  if (selection?.kind !== "container") return;
  const selectedIndex = selection.index;
  mutate(() => {
    const selected = state.containerParts[selectedIndex]; if (!selected || selected.operation !== "add") return;
    const primitives = state.containerParts.map((entry) => entry.primitive);
    const target = state.containerParts.find((entry, index) => index !== selectedIndex && entry.operation === "add" && !dependsOn(primitives, entry.primitive.id, selected.primitive.id));
    if (!target) return;
    selected.primitive.snap = { targetId: target.primitive.id, ownAnchor: "center", targetAnchor: "right", offset: { x: 0, y: 0 } };
  });
  setStatus("success", "Material joined · additive regions are unified for packing");
}

function deleteToolbarSelection(): void {
  if (selections.length > 1) { deleteMultipleSelections(); return; }
  if (!selection || selection.kind === "placement") return;
  if (selection.kind === "container") { deleteSelectedObject(); return; }
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
      const removeParts = (kind: "item" | "exclusion", owners: Array<{ parts: PrimitiveEditor[] }>) => selections
        .flatMap((entry) => entry.kind === kind && entry.partIndex !== undefined ? [{ index: entry.index, partIndex: entry.partIndex }] : [])
        .sort((a, b) => b.index - a.index || b.partIndex - a.partIndex)
        .forEach((entry) => owners[entry.index]?.parts.splice(entry.partIndex, 1));
      removeParts("item", state.items); removeParts("exclusion", state.exclusions);
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
  selectedPartIndex = Math.min(selectedPartIndex, Math.max(0, parts.length - 1));
}

function updateToolbarState(): void {
  const selectedRegion = selection?.kind === "container" ? state.containerParts[selection.index] : null;
  const primitives = state.containerParts.map((entry) => entry.primitive);
  const canJoin = selectedRegion?.operation === "add" && state.containerParts.some((entry) => entry !== selectedRegion && entry.operation === "add" && !dependsOn(primitives, entry.primitive.id, selectedRegion.primitive.id));
  element<HTMLButtonElement>("join-material").disabled = !canJoin;
  element<HTMLButtonElement>("delete-selection").disabled = selections.length === 0 || (selections.length === 1 && selection?.kind === "placement");
  const color = element<HTMLInputElement>("toolbar-part-color"), parts = selectedPrimitivesForColor();
  color.disabled = parts.length === 0; color.value = partColor(parts[0]);
}

function deleteSelectedObject(): void {
  if (!selection || selection.kind === "placement") return;
  mutate(() => {
    if (selection?.kind === "item") { state.items.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "exclusion") { state.exclusions.splice(selection.index, 1); selection = null; }
    else if (selection?.kind === "container") {
      state.containerParts.splice(selection.index, 1); selection = null;
    }
    selections = []; selectedPartIndex = 0;
  });
  refreshPacking(true);
}

function copySelectedItems(): void {
  const placementIndexes = selections.filter((entry) => entry.kind === "placement").map((entry) => entry.index);
  if (placementIndexes.length && currentResult) {
    placementClipboard = placementIndexes.map((index) => currentResult!.placements[index]).filter(Boolean).map((entry) => structuredClone(entry));
    itemClipboard = [];
    setStatus("success", `${placementClipboard.length} solved placement${placementClipboard.length === 1 ? "" : "s"} copied`); return;
  }
  const indexes = selections.filter((entry) => entry.kind === "item").map((entry) => entry.index);
  itemClipboard = indexes.map((index) => state.items[index]).filter(Boolean).map((item) => structuredClone(item));
  placementClipboard = [];
  setStatus(itemClipboard.length ? "success" : "neutral", itemClipboard.length ? `${itemClipboard.length} item${itemClipboard.length === 1 ? "" : "s"} copied` : "Select a packable item to copy");
}

function pasteItems(): void {
  if (placementClipboard.length && currentResult) {
    const start = currentResult.placements.length;
    const copies = placementClipboard.map((source) => ({ ...structuredClone(source), x: source.x + 1, y: source.y - 1, fixed: false }));
    currentResult.placements.push(...copies); currentResult.packed_item_count = currentResult.placements.length;
    selections = copies.map((_, offset) => ({ kind: "placement", index: start + offset })); selection = selections.at(-1) ?? null;
    manualLayout = true; resultStale = true; refreshPacking(); renderPackingSidebar(); updateDiagnostics();
    setStatus("neutral", `${copies.length} placement${copies.length === 1 ? "" : "s"} pasted · validation is stale`); return;
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

function openProjects(): void {
  renderProjectDialog();
  element<HTMLDialogElement>("project-dialog").showModal();
}

function renderProjectDialog(): void {
  const host = element("project-dialog-body");
  host.innerHTML = `<div class="project-dialog-grid"><label>Active project<select id="project-select" aria-label="Local project">${projects.projects.map((project) => `<option value="${project.id}" ${project.id === projects.activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></label><label>Project name<input id="project-name" aria-label="Project name" value="${escapeHtml(projects.active.name)}"></label></div>
    <div class="dialog-actions"><button id="new-project" type="button" class="button ghost">New project</button><button id="empty-project" type="button" class="button ghost">New empty</button><button id="duplicate-project" type="button" class="button ghost">Duplicate</button><button id="delete-project" type="button" class="button danger">Delete</button><span></span><button id="save-project" type="button" class="button primary">Save changes</button></div>
    <details class="json-panel"><summary>Problem JSON <span>Import / export</span></summary><div class="details-body"><textarea id="problem-json" rows="11">${escapeHtml(JSON.stringify(toProblem(state), null, 2))}</textarea><div class="inline-actions"><button id="load-json" type="button" class="button ghost">Load JSON</button><button id="copy-problem" type="button" class="button ghost">Copy JSON</button></div></div></details>`;
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
  selection = { kind: "container", index: 0 };
  selections = [selection];
  renderPackingSidebar(); renderSensitivitySidebar(); updateHistoryButtons(); showPage("packing"); refreshPacking(true);
  setStatus("success", `Opened ${project.name}`);
}

function renderSensitivitySidebar(): void {
  const sidebar = element("sensitivity-sidebar");
  sidebar.innerHTML = `<div class="side-heading"><div><small>SENSITIVITY</small><h2>Study configuration</h2></div><span>${state.study.strategy}</span></div>
    <section class="sidebar-section"><div class="field-grid two">
      <label class="wide">Parameter<select id="study-parameter">${parameterOptions()}</select></label>
      ${studyNumber("Start", "start", state.study.start, .1)}${studyNumber("End", "end", state.study.end, .1)}
      ${studyNumber("Initial step", "initial_step", state.study.initial_step, .05)}${studyNumber("Tolerance", "transition_tolerance", state.study.transition_tolerance, .01)}
      <label>Sampling<select id="study-strategy"><option value="adaptive" ${state.study.strategy === "adaptive" ? "selected" : ""}>Adaptive refinement</option><option value="sampled" ${state.study.strategy === "sampled" ? "selected" : ""}>Sampled sweep</option></select></label>
      <label>Seed policy<select id="seed-policy"><option value="fixed" ${state.study.seed_policy === "fixed" ? "selected" : ""}>Fixed</option><option value="derive_from_value" ${state.study.seed_policy === "derive_from_value" ? "selected" : ""}>Derive per value</option></select></label>
    </div><button id="run-study" class="button primary full">Run sensitivity study</button></section>`;
  sidebar.querySelector<HTMLSelectElement>("#study-parameter")!.addEventListener("change", (event) => studyChange(() => { state.study.parameterKey = (event.target as HTMLSelectElement).value; }));
  sidebar.querySelector<HTMLSelectElement>("#study-strategy")!.addEventListener("change", (event) => studyChange(() => { state.study.strategy = (event.target as HTMLSelectElement).value as EditorState["study"]["strategy"]; }));
  sidebar.querySelector<HTMLSelectElement>("#seed-policy")!.addEventListener("change", (event) => studyChange(() => { state.study.seed_policy = (event.target as HTMLSelectElement).value as EditorState["study"]["seed_policy"]; }));
  sidebar.querySelectorAll<HTMLInputElement>("[data-study-field]").forEach((input) => input.addEventListener("change", () => studyChange(() => setField(state.study, input.dataset.studyField!, Number(input.value)))));
  sidebar.querySelector("#run-study")!.addEventListener("click", () => void runStudy());
  requestAnimationFrame(renderStudyGeometryPreview);
}

function studyChange(change: () => void): void { mutate(change, false); renderSensitivitySidebar(); refreshSensitivityPage(); setStatus("neutral", "Study configuration changed"); }

function renderStudyGeometryPreview(): void {
  const host = element("study-shape-preview");
  const values = studyValues(state.study.start, state.study.end, state.study.initial_step);
  const itemIndex = itemIndexForParameter(state.study.parameterKey);
  host.innerHTML = values.map((value, index) => `<article class="shape-step ${index === 0 || index === values.length - 1 ? "extreme" : ""}"><header><strong>${format(value)}</strong><span>${index === 0 ? "START" : index === values.length - 1 ? "END" : `STEP ${index}`}</span></header><canvas data-study-preview="${index}"></canvas></article>`).join("");
  host.querySelectorAll<HTMLCanvasElement>("[data-study-preview]").forEach((canvas, index) => {
    const previewState = stateAtParameter(values[index]);
    const previewProblem = toProblem(previewState);
    if (itemIndex >= 0) renderPolygonsPreview(canvas, resolveGeometry(previewProblem).items[itemIndex]?.polygons ?? []);
    else renderLayout(canvas, previewProblem, [], studyDisplay);
  });
}

function stateAtParameter(value: number): EditorState {
  const clone = structuredClone(state); const [kind, id] = clone.study.parameterKey.split(":");
  const itemIndex = clone.items.findIndex((item) => item.id === id);
  if (itemIndex >= 0 && (kind.startsWith("part_") || kind === "item_scale")) clone.items[itemIndex] = cloneItemAtParameter(clone.items[itemIndex], clone.study.parameterKey, value);
  else if (kind === "item_quantity" && itemIndex >= 0) clone.items[itemIndex].quantity = Math.max(0, Math.round(value));
  else if (kind.startsWith("container_part_")) {
    const part = clone.containerParts.find((entry) => entry.id === id)?.primitive;
    if (part) applyPrimitiveParameter(part, kind.replace("container_part_", ""), value);
  } else if (kind === "container_width" || kind === "container_height") {
    const part = clone.containerParts.find((entry) => entry.operation === "add")?.primitive;
    if (part) applyPrimitiveParameter(part, kind === "container_width" ? "width" : "height", value);
  } else if (kind === "exclusion_scale") {
    clone.exclusions.find((entry) => entry.id === id)?.parts.forEach((part) => scalePrimitivePreview(part, value));
  } else if (kind === "clearance_item_to_item") clone.clearance.item_to_item = value;
  else if (kind === "clearance_item_to_boundary") clone.clearance.item_to_boundary = value;
  return clone;
}

function applyPrimitiveParameter(part: PrimitiveEditor, kind: string, value: number): void {
  if (kind === "scale") { scalePrimitivePreview(part, value); return; }
  if (kind === "width") {
    if (part.kind === "rectangle") part.width = value; else if (part.kind === "triangle") part.base = value; else scaleAxis(part, "x", value);
  } else if (kind === "height") {
    if (part.kind === "rectangle" || part.kind === "triangle") part.height = value; else scaleAxis(part, "y", value);
  }
}

function scalePrimitivePreview(part: PrimitiveEditor, scale: number): void {
  if (part.kind === "rectangle") { part.width *= scale; part.height *= scale; }
  else if (part.kind === "triangle") { part.base *= scale; part.height *= scale; }
  else if (part.kind === "circle") part.radius *= scale;
  else if (part.kind === "polygon") part.vertices.forEach((point) => { point.x *= scale; point.y *= scale; });
  else part.knots.forEach((knot) => [knot.point, knot.control_in, knot.control_out].forEach((point) => { point.x *= scale; point.y *= scale; }));
}

function scaleAxis(part: PrimitiveEditor, axis: "x" | "y", target: number): void {
  const points = part.kind === "polygon" ? part.vertices : part.kind === "bezier" ? part.knots.flatMap((knot) => [knot.point, knot.control_in, knot.control_out]) : [];
  if (!points.length) return; const values = points.map((point) => point[axis]); const min = Math.min(...values), span = Math.max(...values) - min;
  if (span > 0) points.forEach((point) => { point[axis] = min + (point[axis] - min) * target / span; });
}

async function solve(): Promise<void> {
  if (running) return;
  try {
    const problem = toProblem(state); setRunning(true, "Preparing geometry…"); currentResult = null; manualLayout = false; resultStale = false;
    currentResult = await client.solve(problem, state.options, (progress) => updateProgress(problem, progress));
    setStatus("success", `${currentResult.packed_item_count} items · ${state.options.baseline_only ? "Baseline validated" : humanStatus(currentResult.status)}`); showPackingResult(problem, currentResult);
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
  element("solve-stage").textContent = humanStatus(progress.phase);
  element("solve-detail").textContent = `${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`;
  setStatus("working", `${humanStatus(progress.phase)} · ${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`);
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
  const result = currentResult;
  if (!result) { element("diagnostics").innerHTML = "<p>Run a solve to inspect validation and search statistics.</p>"; return; }
  const phases = result.runtime_timing ? Object.entries(result.runtime_timing.phase_ms).map(([phase, elapsed]) => `<dt>${humanStatus(phase)}</dt><dd>${formatDuration(elapsed ?? 0)}</dd>`).join("") : "";
  element("diagnostics").innerHTML = `${manualLayout || resultStale ? `<div class="warning">${resultStale ? "The problem definition changed after solving. The layout remains visible as a reference, but its validation is stale." : "This result was manually edited after solving. Geometry and collision validation shown below applies to the original solver output."}</div>` : ""}<div class="diagnostic-metrics">${metricsHtml(result)}</div><dl><dt>Status</dt><dd>${humanStatus(result.status)}</dd><dt>Strategy</dt><dd>${escapeHtml(result.solver_strategy)}</dd><dt>Layout</dt><dd>${result.layout_id}</dd><dt>Seed</dt><dd>${result.seed}</dd><dt>Workers</dt><dd>${result.runtime_timing?.worker_count ?? 1}</dd><dt>Iterations</dt><dd>${result.statistics.iterations.toLocaleString()}</dd><dt>Counts</dt><dd>${Object.entries(result.packed_count_by_item).map(([key, value]) => `${escapeHtml(key)}: ${value}`).join(" · ")}</dd>${phases}</dl>${result.warnings.length ? `<div class="warning">${result.warnings.map(escapeHtml).join("<br>")}</div>` : '<div class="validation-ok">✓ Independent final validation passed</div>'}`;
}

function renderSensitivityResults(): void { renderSensitivity(element("sensitivity-canvas"), sensitivityResult, sensitivitySelection); renderTransitions(); }

function renderTransitions(): void {
  const host = element("transitions");
  if (!sensitivityResult) { host.innerHTML = '<p class="empty-state">Run the study to locate capacity transitions.</p>'; return; }
  host.innerHTML = sensitivityResult.transitions.map((transition) => `<article class="transition"><header><strong>${transition.lower_capacity} → ${transition.upper_capacity}</strong><span>${format(transition.lower_value)}–${format(transition.upper_value)}</span></header><div><button data-value="${transition.lower_value}"><b>Before</b><span>${transition.lower_capacity} @ ${format(transition.lower_value)}</span></button><button data-value="${transition.upper_value}"><b>After</b><span>${transition.upper_capacity} @ ${format(transition.upper_value)}</span></button></div></article>`).join("") || '<p class="empty-state">No capacity transition was observed.</p>';
  host.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", () => selectSensitivityEvaluation(Number(button.dataset.value), button.querySelector("b")!.textContent!.toLowerCase())));
}

function selectSensitivityEvaluation(value: number, side: string): void {
  if (!sensitivityResult) return;
  const evaluation = sensitivityResult.evaluations.reduce((best, entry) => Math.abs(entry.value - value) < Math.abs(best.value - value) ? entry : best);
  sensitivitySelection = evaluation.value; renderSensitivity(element("sensitivity-canvas"), sensitivityResult, evaluation.value);
  renderLayout(element("sensitivity-layout-canvas"), evaluation.problem, evaluation.result.placements, studyDisplay);
  element("sensitivity-layout-title").textContent = `${evaluation.capacity} items at ${format(evaluation.value)}`;
  element("sensitivity-layout-id").textContent = evaluation.result.layout_id;
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
  const progress = document.getElementById("study-progress"); if (progress) progress.hidden = true;
}
function markResultStale(): void {
  sensitivityResult = null; sensitivitySelection = null;
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
  const options: Array<[string, string]> = [];
  state.items.forEach((item) => {
    options.push([`item_scale:${item.id}`, `${item.id} · whole shape scale`], [`item_quantity:${item.id}`, `${item.id} · quantity`]);
    item.parts.forEach((part, index) => {
      options.push([`part_scale:${item.id}:${index}`, `${item.id} · ${part.id} scale`]);
      if (part.kind === "rectangle" || part.kind === "triangle" || part.kind === "polygon" || part.kind === "bezier") options.push([`part_width:${item.id}:${index}`, `${item.id} · ${part.id} width/base`], [`part_height:${item.id}:${index}`, `${item.id} · ${part.id} height`]);
      if (part.kind === "circle") options.push([`part_radius:${item.id}:${index}`, `${item.id} · ${part.id} radius`]);
    });
  });
  state.containerParts.forEach((part) => options.push([`container_part_scale:${part.id}`, `${part.id} · scale`], [`container_part_width:${part.id}`, `${part.id} · width`], [`container_part_height:${part.id}`, `${part.id} · height`]));
  options.push(["clearance_item_to_item", "Item-to-item clearance"], ["clearance_item_to_boundary", "Boundary clearance"], ["container_width", "Container width"], ["container_height", "Container height"]);
  state.exclusions.forEach((entry) => options.push([`exclusion_scale:${entry.id}`, `${entry.id} · scale`]));
  if (!options.some(([value]) => value === state.study.parameterKey)) state.study.parameterKey = options[0]?.[0] ?? "container_width";
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === state.study.parameterKey ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function buildStudy(): SensitivityStudy { return { parameter: decodeParameter(state.study.parameterKey), start: state.study.start, end: state.study.end, initial_step: state.study.initial_step, transition_tolerance: state.study.transition_tolerance, strategy: state.study.strategy, solve_options: state.options, seed_policy: state.study.seed_policy, increasing_is_harder: state.study.increasing_is_harder }; }
function decodeParameter(key: string): ParameterPath {
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

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme; projects.setTheme(theme);
  element("theme-toggle").textContent = theme === "dark" ? "☀" : "☾"; element("theme-toggle-study").textContent = theme === "dark" ? "☀" : "☾";
  requestAnimationFrame(() => refreshCurrentPage());
}
function bindOverlay(prefix: string, target: { dimensions: boolean; clearance: boolean }): void {
  element<HTMLInputElement>(`${prefix}-dimensions`).addEventListener("change", (event) => { target.dimensions = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
  element<HTMLInputElement>(`${prefix}-clearance`).addEventListener("change", (event) => { target.clearance = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
}
function overlayToggles(prefix: string): string { return `<div class="layout-tools"><label><input id="${prefix}-dimensions" type="checkbox"> Dimensions</label><label><input id="${prefix}-clearance" type="checkbox"> Clearance</label></div>`; }
function updateHistoryButtons(): void { element<HTMLButtonElement>("undo").disabled = !history.canUndo; element<HTMLButtonElement>("redo").disabled = !history.canRedo; }
function normalizeSelection(value: CadSelection | null): CadSelection | null {
  if (!value || value.kind === "placement") return state.containerParts.length ? { kind: "container", index: 0 } : null;
  const length = value.kind === "container" ? state.containerParts.length : value.kind === "exclusion" ? state.exclusions.length : state.items.length;
  return value.index < length ? value : length ? { kind: value.kind, index: 0 } : null;
}
function isEditingText(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest("input, textarea, select, [contenteditable='true']");
}
function parseSelection(value: string): CadSelection { const [kind, index] = value.split(":"); return { kind: kind as CadSelection["kind"], index: Number(index) } as CadSelection; }
function sameSelection(a: CadSelection, b: CadSelection): boolean { return a.kind === b.kind && a.index === b.index && ("partIndex" in a ? a.partIndex : undefined) === ("partIndex" in b ? b.partIndex : undefined); }
function isPartSelection(value: CadSelection): value is Extract<CadSelection, { kind: "item" | "exclusion" }> { return (value.kind === "item" || value.kind === "exclusion") && value.partIndex !== undefined; }
function itemIndexForParameter(key: string): number { const [kind, id] = key.split(":"); return kind.startsWith("part_") || kind.startsWith("item_") ? state.items.findIndex((item) => item.id === id) : -1; }
function studyValues(start: number, end: number, step: number): number[] { const values = [start]; if (step > 0) for (let value = start + step; value < end && values.length < 6; value += step) values.push(value); if (end !== start) values.push(end); return values; }
function numberField(label: string, scope: string, field: string, value: number, step: number): string { return `<label title="${escapeHtml(optionHelp(field))}">${label}<input type="number" value="${value}" step="${step}" data-pack-scope="${scope}" data-field="${field}"></label>`; }
function optionHelp(field: string): string {
  return ({ item_to_item: "Minimum edge-to-edge gap between packed items.", item_to_boundary: "Minimum distance from each item to the container boundary.", item_to_exclusion: "Minimum distance from items to keep-out regions.", seed: "Reuses the same random sequence for repeatable layouts.", max_iterations: "Search effort per restart; higher values can improve layouts but take longer.", grid_step: "Translation sampling interval; smaller values are more precise and slower.", restarts: "Independent searches; more restarts improve robustness at added runtime." } as Record<string, string>)[field] ?? labelForHelp(field);
}
function labelForHelp(field: string): string { return `Controls ${humanStatus(field).toLowerCase()} for this packing problem.`; }
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
function placementField(label: string, field: keyof Placement, value: number, step: number): string { return `<label>${label}<input type="number" value="${format(value)}" step="${step}" data-placement-field="${field}"></label>`; }
function primitiveNumber(label: string, field: string, value: number, step = .1): string { return `<label>${label}<input type="number" value="${format(value)}" step="${step}" data-primitive-field="${field}"></label>`; }
function objectNumber(label: string, field: string, value: number, step = .1): string { return `<label>${label}<input type="number" value="${format(value)}" step="${step}" data-object-field="${field}"></label>`; }
function snapNumber(label: string, field: "x" | "y", value: number): string { return `<label>${label}<input type="number" value="${format(value)}" step=".1" data-snap-offset="${field}"></label>`; }
function fixedPlacementsHtml(): string {
  const rows = state.fixedPlacements.map((placement, index) => `<div class="fixed-inline-row" data-fixed-row="${index}">
    <select aria-label="Fixed placement item">${state.items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === placement.item_id ? "selected" : ""}>${escapeHtml(item.id)}</option>`).join("")}</select>
    <input aria-label="Fixed placement X" type="number" step=".1" value="${format(placement.x)}" data-fixed-field="x">
    <input aria-label="Fixed placement Y" type="number" step=".1" value="${format(placement.y)}" data-fixed-field="y">
    <input aria-label="Fixed placement rotation" type="number" step="1" value="${format(placement.rotation_deg)}" data-fixed-field="rotation_deg">
    <button aria-label="Delete fixed placement" data-delete-fixed>×</button>
  </div>`).join("");
  return `<div class="fixed-inline-head"><span>Item</span><span>X</span><span>Y</span><span>Rot°</span><span></span></div>${rows || '<p class="empty-inline">No fixed items.</p>'}<button id="add-fixed-inline" class="button ghost full">+ Add fixed placement</button>`;
}
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
function anchorOptions(selected: AnchorName): string { return ANCHORS.map((anchor) => `<option value="${anchor}" ${anchor === selected ? "selected" : ""}>${humanStatus(anchor)}</option>`).join(""); }
function partColor(part: PrimitiveEditor | null | undefined): string {
  return part?.color && /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : "#51c6a4";
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
  else state.items[selection.index].parts[selection.partIndex ?? selectedPartIndex] = next;
}
function dependsOn(parts: PrimitiveEditor[], startId: string, targetId: string): boolean {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const seen = new Set<string>(); let current = byId.get(startId);
  while (current?.snap && !seen.has(current.id)) {
    if (current.snap.targetId === targetId) return true;
    seen.add(current.id); current = byId.get(current.snap.targetId);
  }
  return false;
}
function studyNumber(label: string, field: string, value: number, step: number): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-study-field="${field}"></label>`; }
function metricsHtml(result: SolveResult): string { return metricHtml("Packed", result.packed_item_count) + metricHtml("Upper bound", result.simple_upper_bound ?? "—") + metricHtml("Candidates", result.statistics.candidates_evaluated.toLocaleString()) + metricHtml("Elapsed", formatDuration(result.runtime_timing?.total_ms ?? result.statistics.elapsed_ms)) + metricHtml("Validation", result.validation.valid ? "Passed" : "Failed"); }
function metricHtml(label: string, value: string | number): string { return `<div><small>${label}</small><strong>${value}</strong></div>`; }
function setField(target: object, field: string, value: unknown): void { (target as Record<string, unknown>)[field] = value; }
function humanStatus(value: string): string { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""); }
function formatDuration(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]!); }
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
