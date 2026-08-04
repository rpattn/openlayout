import "./style.css";
import { ShapeModeller } from "./modeller";
import { SolverClient } from "./solver-client";
import { cloneItemAtParameter, fromProblem, toProblem } from "./problem";
import { renderLayout, renderSensitivity, renderShapePreview, sensitivityValueAt } from "./renderer";
import { WorkspaceHistory, WorkspaceStore } from "./workspace-store";
import type {
  EditorState, PackingProblem, ParameterPath, PrimitiveEditor, SensitivityProgress,
  SensitivityResult, SensitivityStudy, SolveProgress, SolveResult,
} from "./types";

type PageName = "packing" | "modeller" | "sensitivity";
type StatusTone = "neutral" | "working" | "success" | "error";

const root = document.querySelector<HTMLDivElement>("#app")!;
const client = new SolverClient();
const projects = new WorkspaceStore();
const history = new WorkspaceHistory();
let state = structuredClone(projects.active.state);
let committedState = structuredClone(state);
let page: PageName = "packing";
let currentResult: SolveResult | null = null;
let sensitivityResult: SensitivityResult | null = null;
let sensitivitySelection: number | null = null;
let modeller: ShapeModeller | null = null;
let running = false;
const display = { dimensions: false, clearance: false };
const modelDisplay = { dimensions: true, clearance: true };

root.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">OL</span><div><strong>OpenLayout</strong><small>packing studio</small></div></div>
    <div class="project-switcher">
      <label for="project-select">Local project</label>
      <select id="project-select" aria-label="Local project"></select>
      <button id="save-project" class="icon-action" title="Save project" aria-label="Save project">Save</button>
      <button id="new-project" class="icon-action" title="New project" aria-label="New project">＋</button>
      <button id="duplicate-project" class="icon-action" title="Duplicate project" aria-label="Duplicate project">⧉</button>
      <button id="delete-project" class="icon-action danger-text" title="Delete project" aria-label="Delete project">−</button>
    </div>
    <nav class="view-switch" aria-label="Workspace pages">
      <button data-page="packing" class="active">Packing</button>
      <button data-page="modeller">Modeller</button>
      <button data-page="sensitivity">Sensitivity</button>
    </nav>
    <div class="workspace-actions">
      <button id="undo" class="icon-action" title="Undo (Ctrl/⌘ Z)" aria-label="Undo" disabled>↶</button>
      <button id="redo" class="icon-action" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo" disabled>↷</button>
      <button id="theme-toggle" class="icon-action" aria-label="Toggle theme">◐</button>
      <progress id="solve-progress" max="100" value="0" hidden aria-label="Packing solve progress"></progress>
      <span id="status" class="status neutral">Saved locally</span>
      <button id="validate" class="button ghost">Validate</button>
      <button id="cancel" class="button danger" disabled>Stop</button>
      <button id="solve" class="button primary">Run packing</button>
    </div>
  </header>
  <section id="packing-page" class="app-page">
    <div class="page-shell packing-shell">
      <aside id="packing-sidebar" class="side-panel"></aside>
      <main class="packing-content">
        <section class="panel layout-panel">
          <div class="panel-heading"><div><small>PACKING WORKSPACE</small><h1 id="layout-title">Problem preview</h1></div>${overlayToggles("packing")}</div>
          <canvas id="layout-canvas" aria-label="Packing layout"></canvas>
          <div id="metrics" class="metrics"></div>
        </section>
        <section class="panel diagnostics-panel compact-panel">
          <div class="panel-heading"><div><small>ENGINE OUTPUT</small><h2>Diagnostics</h2></div><button id="copy-result" class="text-button">Copy JSON</button></div>
          <div id="diagnostics" class="diagnostics"><p>Run a solve to inspect validation and search statistics.</p></div>
        </section>
      </main>
    </div>
  </section>
  <section id="modeller-page" class="app-page" hidden></section>
  <section id="sensitivity-page" class="app-page" hidden>
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
  </section>`;

applyTheme(projects.theme);
bindShell();
renderProjectSwitcher();
renderPackingSidebar();
renderSensitivitySidebar();
showPage("packing");

function bindShell(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page as PageName)));
  element("save-project").addEventListener("click", () => { projects.save(state); setStatus("success", "Project saved on this device"); renderProjectSwitcher(); });
  element("new-project").addEventListener("click", () => { projects.save(state); loadProject(projects.create().id); });
  element("duplicate-project").addEventListener("click", () => { projects.save(state); loadProject(projects.duplicate().id); });
  element("delete-project").addEventListener("click", () => {
    try { const name = projects.active.name; if (!confirm(`Delete “${name}” from this device?`)) return; loadProject(projects.deleteActive().id); }
    catch (error) { setStatus("error", errorMessage(error)); }
  });
  element<HTMLSelectElement>("project-select").addEventListener("change", (event) => { projects.save(state); loadProject((event.target as HTMLSelectElement).value); });
  element("undo").addEventListener("click", undo);
  element("redo").addEventListener("click", redo);
  element("theme-toggle").addEventListener("click", () => applyTheme(projects.theme === "dark" ? "light" : "dark"));
  element("solve").addEventListener("click", () => void solve());
  element("validate").addEventListener("click", () => void validate());
  element("cancel").addEventListener("click", cancel);
  element("copy-result").addEventListener("click", () => void copyResult());
  bindOverlay("packing", display);
  bindOverlay("study", display);
  const chart = element<HTMLCanvasElement>("sensitivity-canvas");
  chart.addEventListener("click", (event) => {
    if (sensitivityResult) selectSensitivityEvaluation(sensitivityValueAt(chart, sensitivityResult, event.clientX), "graph");
  });
  element("sensitivity-scroll").addEventListener("wheel", (event) => {
    const scroll = event.currentTarget as HTMLElement;
    if (scroll.scrollWidth > scroll.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { scroll.scrollLeft += event.deltaY; event.preventDefault(); }
  }, { passive: false });
  window.addEventListener("resize", refreshCurrentPage);
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    if (event.key.toLowerCase() === "s") { event.preventDefault(); projects.save(state); setStatus("success", "Project saved on this device"); }
  });
}

function showPage(next: PageName, target: number | string = 0): void {
  page = next;
  modeller?.destroy(); modeller = null;
  document.querySelectorAll<HTMLElement>(".app-page").forEach((entry) => { entry.hidden = entry.id !== `${next}-page`; });
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === next));
  element("solve").hidden = next !== "packing";
  if (next === "modeller") {
    modeller = new ShapeModeller(element("modeller-page"), state, validModelTarget(target), modellerChanged, undefined, modelDisplay);
  } else if (next === "packing") {
    renderPackingSidebar(); requestAnimationFrame(refreshPacking);
  } else {
    renderSensitivitySidebar(); requestAnimationFrame(refreshSensitivityPage);
  }
}

function renderProjectSwitcher(): void {
  element<HTMLSelectElement>("project-select").innerHTML = projects.projects.map((project) =>
    `<option value="${project.id}" ${project.id === projects.activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
}

function loadProject(id: string): void {
  const project = projects.switch(id);
  state = structuredClone(project.state); committedState = structuredClone(state); history.clear(); clearResults();
  renderProjectSwitcher(); renderPackingSidebar(); renderSensitivitySidebar(); updateHistoryButtons(); showPage("packing");
  setStatus("success", `Opened ${project.name}`);
}

function renderPackingSidebar(): void {
  const sidebar = element("packing-sidebar");
  sidebar.innerHTML = `
    <div class="side-heading"><div><small>PROJECT</small><input id="project-name" value="${escapeHtml(projects.active.name)}" aria-label="Project name"></div><span>On-device</span></div>
    <section class="sidebar-section"><div class="section-title"><div><small>PROBLEM</small><h2>Geometry overview</h2></div><button class="text-button" data-open-model="container:0">Edit in modeller</button></div>
      <article class="preview-card container-card"><canvas id="container-preview" aria-label="Container preview"></canvas><footer><strong>Container</strong><span>${state.containerParts.length} region${state.containerParts.length === 1 ? "" : "s"} · ${state.exclusions.length} exclusion${state.exclusions.length === 1 ? "" : "s"}</span></footer></article>
      <div class="preview-list">${state.items.map((item, index) => `<article class="preview-card"><canvas data-item-preview="${index}" aria-label="${escapeHtml(item.id)} preview"></canvas><footer><strong>${escapeHtml(item.id)}</strong><span>${item.quantity} requested · ${rotationSummary(item)}</span><button class="text-button" data-open-model="${index}">Edit</button></footer></article>`).join("")}</div>
    </section>
    <section class="sidebar-section"><div class="section-title"><div><small>CONSTRAINTS</small><h2>Clearance</h2></div></div><div class="field-grid three">
      ${numberField("Item ↔ item", "clearance", "item_to_item", state.clearance.item_to_item, .05)}
      ${numberField("Boundary", "clearance", "item_to_boundary", state.clearance.item_to_boundary, .05)}
      ${numberField("Exclusion", "clearance", "item_to_exclusion", state.clearance.item_to_exclusion, .05)}
    </div></section>
    <section class="sidebar-section"><div class="section-title"><div><small>SOLVER</small><h2>Run configuration</h2></div></div><div class="field-grid two">
      ${numberField("Seed", "option", "seed", state.options.seed, 1)}${numberField("Base iterations", "option", "max_iterations", state.options.max_iterations, 1000)}
      ${numberField("Grid step", "option", "grid_step", state.options.grid_step, .1)}${numberField("Restarts", "option", "restarts", state.options.restarts, 1)}
      <label class="wide">Quality<select data-pack-scope="option" data-field="quality"><option value="fast" ${state.options.quality === "fast" ? "selected" : ""}>Fast preview</option><option value="balanced" ${state.options.quality === "balanced" ? "selected" : ""}>Balanced</option><option value="thorough" ${state.options.quality === "thorough" ? "selected" : ""}>Thorough</option></select></label>
    </div><p class="hint">Geometry transforms are edited only in the Modeller. Packing settings remain reproducible and iteration bounded.</p></section>
    <details class="sidebar-section"><summary>Problem JSON <span>Import / export</span></summary><div class="details-body"><textarea id="problem-json" rows="9">${escapeHtml(JSON.stringify(toProblem(state), null, 2))}</textarea><div class="inline-actions"><button id="load-json" class="button ghost">Load JSON</button><button id="copy-problem" class="button ghost">Copy JSON</button></div></div></details>`;
  sidebar.querySelector<HTMLInputElement>("#project-name")!.addEventListener("change", (event) => {
    try { projects.rename((event.target as HTMLInputElement).value); renderProjectSwitcher(); setStatus("success", "Project renamed"); }
    catch (error) { setStatus("error", errorMessage(error)); }
  });
  sidebar.querySelectorAll<HTMLElement>("[data-open-model]").forEach((node) => node.addEventListener("click", () => {
    const target = node.dataset.openModel!; showPage("modeller", /^\d+$/.test(target) ? Number(target) : target);
  }));
  sidebar.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pack-scope]").forEach((input) => input.addEventListener("change", () => mutate(() => {
    const target = input.dataset.packScope === "clearance" ? state.clearance : state.options;
    setField(target, input.dataset.field!, input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value);
  }, false)));
  sidebar.querySelector("#load-json")!.addEventListener("click", () => mutate(() => {
    const problem = JSON.parse(sidebar.querySelector<HTMLTextAreaElement>("#problem-json")!.value) as PackingProblem;
    const options = state.options, study = state.study; state = fromProblem(problem); state.options = options; state.study = study;
  }));
  sidebar.querySelector("#copy-problem")!.addEventListener("click", () => void navigator.clipboard.writeText(JSON.stringify(toProblem(state), null, 2)));
  requestAnimationFrame(renderPackingPreviews);
}

function renderPackingPreviews(): void {
  const problem = toProblem(state);
  const container = document.querySelector<HTMLCanvasElement>("#container-preview");
  if (container) renderLayout(container, problem, [], display);
  document.querySelectorAll<HTMLCanvasElement>("[data-item-preview]").forEach((canvas) => {
    const item = problem.items[Number(canvas.dataset.itemPreview)]; if (item) renderShapePreview(canvas, item.shape);
  });
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
    </div><button id="run-study" class="button primary full">Run sensitivity study</button><p class="hint">The preview shows the actual target geometry at the configured start, intermediate steps, and end. Container studies render the changing field.</p></section>`;
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
    if (itemIndex >= 0) renderShapePreview(canvas, toProblem(previewState).items[itemIndex].shape);
    else renderLayout(canvas, toProblem(previewState), [], display);
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
    const part = clone.exclusions.find((entry) => entry.id === id)?.primitive; if (part) scalePrimitivePreview(part, value);
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
    const problem = toProblem(state); setRunning(true, "Preparing geometry…"); currentResult = null;
    currentResult = await client.solve(problem, state.options, (progress) => updateProgress(problem, progress));
    setStatus("success", `${currentResult.packed_item_count} items · ${humanStatus(currentResult.status)}`); showPackingResult(problem, currentResult);
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
  setStatus("working", `${humanStatus(progress.phase)} · ${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`);
  renderLayout(element("layout-canvas"), problem, progress.placements, display);
  element("layout-title").textContent = `Improving · ${progress.packed_item_count} items`;
}

function showPackingResult(problem: PackingProblem, result: SolveResult): void {
  renderLayout(element("layout-canvas"), problem, result.placements, display);
  element("layout-title").textContent = `${result.packed_item_count} packed items`;
  element("metrics").innerHTML = metricsHtml(result);
  element("diagnostics").innerHTML = `<dl><dt>Status</dt><dd>${humanStatus(result.status)}</dd><dt>Strategy</dt><dd>${escapeHtml(result.solver_strategy)}</dd><dt>Layout</dt><dd>${result.layout_id}</dd><dt>Seed</dt><dd>${result.seed}</dd><dt>Iterations</dt><dd>${result.statistics.iterations.toLocaleString()}</dd><dt>Counts</dt><dd>${Object.entries(result.packed_count_by_item).map(([key, value]) => `${escapeHtml(key)}: ${value}`).join(" · ")}</dd></dl>${result.warnings.length ? `<div class="warning">${result.warnings.map(escapeHtml).join("<br>")}</div>` : '<div class="validation-ok">✓ Independent final validation passed</div>'}`;
}

function renderSensitivityResults(): void {
  renderSensitivity(element("sensitivity-canvas"), sensitivityResult, sensitivitySelection); renderTransitions();
}

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
  renderLayout(element("sensitivity-layout-canvas"), evaluation.problem, evaluation.result.placements, display);
  element("sensitivity-layout-title").textContent = `${evaluation.capacity} items at ${format(evaluation.value)}`;
  element("sensitivity-layout-id").textContent = evaluation.result.layout_id;
  element("sensitivity-metrics").innerHTML = metricsHtml(evaluation.result);
  element("transitions").querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.value) === evaluation.value));
  setStatus("neutral", `Viewing ${side} point ${format(evaluation.value)} · ${evaluation.capacity} items`);
}

function modellerChanged(): void {
  history.commit(committedState, state); committedState = structuredClone(state); projects.save(state); clearResults(); updateHistoryButtons(); setStatus("neutral", "Geometry changed · saved locally");
}

function mutate(change: () => void, rerender = true): void {
  const before = structuredClone(state);
  try {
    change(); history.commit(before, state); committedState = structuredClone(state); projects.save(state); clearResults(); updateHistoryButtons();
    if (rerender) { renderPackingSidebar(); renderSensitivitySidebar(); }
    refreshCurrentPage(); setStatus("neutral", "Changes saved locally");
  } catch (error) { state = before; setStatus("error", errorMessage(error)); }
}

function undo(): void { const restored = history.undo(state); if (restored) restoreHistory(restored, "Undid last workspace action"); }
function redo(): void { const restored = history.redo(state); if (restored) restoreHistory(restored, "Redid workspace action"); }
function restoreHistory(restored: EditorState, message: string): void {
  state = restored; committedState = structuredClone(state); projects.save(state); clearResults(); updateHistoryButtons();
  if (page === "modeller") showPage("modeller", 0); else { renderPackingSidebar(); renderSensitivitySidebar(); refreshCurrentPage(); }
  setStatus("neutral", message);
}

function clearResults(): void {
  currentResult = null; sensitivityResult = null; sensitivitySelection = null;
  const progress = document.getElementById("study-progress"); if (progress) progress.hidden = true;
}

function refreshCurrentPage(): void { if (page === "packing") refreshPacking(); else if (page === "sensitivity") refreshSensitivityPage(); }
function refreshPacking(): void {
  try { renderLayout(element("layout-canvas"), toProblem(state), currentResult?.placements ?? [], display); renderPackingPreviews(); }
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
  const progress = element<HTMLProgressElement>("solve-progress"); progress.hidden = !value; if (value) progress.value = 0; if (message) setStatus("working", message);
}
function cancel(): void { if (running) { client.cancel(); setRunning(false); setStatus("neutral", "Run cancelled; worker restarted"); } }
function setStatus(tone: StatusTone, message: string): void { const node = element("status"); node.className = `status ${tone}`; node.textContent = message; }
function handleRunError(error: unknown): void { if (errorMessage(error) !== "Run cancelled") setStatus("error", errorMessage(error)); }
async function copyResult(): Promise<void> { await navigator.clipboard.writeText(JSON.stringify(currentResult ?? sensitivityResult ?? {}, null, 2)); setStatus("success", "Output copied"); }

function applyTheme(theme: "light" | "dark"): void { document.documentElement.dataset.theme = theme; projects.setTheme(theme); element("theme-toggle").textContent = theme === "dark" ? "☀" : "☾"; element("theme-toggle").title = `Use ${theme === "dark" ? "light" : "dark"} theme`; requestAnimationFrame(refreshCurrentPage); }
function bindOverlay(prefix: string, target: { dimensions: boolean; clearance: boolean }): void {
  element<HTMLInputElement>(`${prefix}-dimensions`).addEventListener("change", (event) => { target.dimensions = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
  element<HTMLInputElement>(`${prefix}-clearance`).addEventListener("change", (event) => { target.clearance = (event.target as HTMLInputElement).checked; refreshCurrentPage(); });
}
function overlayToggles(prefix: string): string { return `<div class="layout-tools"><label><input id="${prefix}-dimensions" type="checkbox"> Dimensions</label><label><input id="${prefix}-clearance" type="checkbox"> Clearance</label></div>`; }
function updateHistoryButtons(): void { element<HTMLButtonElement>("undo").disabled = !history.canUndo; element<HTMLButtonElement>("redo").disabled = !history.canRedo; }
function validModelTarget(target: number | string): number | string { if (typeof target === "number" && state.items[target]) return target; if (typeof target === "string" && target.startsWith("container:") && state.containerParts[Number(target.split(":")[1])]) return target; if (typeof target === "string" && target.startsWith("exclusion:") && state.exclusions[Number(target.split(":")[1])]) return target; return state.items.length ? 0 : "container:0"; }
function itemIndexForParameter(key: string): number { const [kind, id] = key.split(":"); return kind.startsWith("part_") || kind.startsWith("item_") ? state.items.findIndex((item) => item.id === id) : -1; }
function studyValues(start: number, end: number, step: number): number[] { const values = [start]; if (step > 0) for (let value = start + step; value < end && values.length < 6; value += step) values.push(value); if (end !== start) values.push(end); return values; }
function numberField(label: string, scope: string, field: string, value: number, step: number): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-pack-scope="${scope}" data-field="${field}"></label>`; }
function studyNumber(label: string, field: string, value: number, step: number): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-study-field="${field}"></label>`; }
function metricsHtml(result: SolveResult): string { return metricHtml("Packed", result.packed_item_count) + metricHtml("Upper bound", result.simple_upper_bound ?? "—") + metricHtml("Candidates", result.statistics.candidates_evaluated.toLocaleString()) + metricHtml("Elapsed", `${result.statistics.elapsed_ms} ms`) + metricHtml("Validation", result.validation.valid ? "Passed" : "Failed"); }
function metricHtml(label: string, value: string | number): string { return `<div><small>${label}</small><strong>${value}</strong></div>`; }
function rotationSummary(item: EditorState["items"][number]): string { return item.rotationMode === "continuous" ? `${format(item.minRotation)}–${format(item.maxRotation)}° adaptive` : `${item.rotations}°`; }
function setField(target: object, field: string, value: unknown): void { (target as Record<string, unknown>)[field] = value; }
function humanStatus(value: string): string { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, ""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!); }
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
