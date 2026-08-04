import "./style.css";
import { SolverClient } from "./solver-client";
import { ShapeModeller } from "./modeller";
import { defaultState, fromProblem, makePrimitive, parsePointText, pointText, toProblem } from "./problem";
import { renderLayout, renderSensitivity, renderShapePreview, sensitivityValueAt } from "./renderer";
import type {
  EditorExclusion, EditorItem, EditorState, PackingProblem, ParameterPath, PrimitiveEditor,
  SensitivityProgress, SensitivityResult, SensitivityStudy, SolveProgress, SolveResult,
} from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
const client = new SolverClient();
let state = defaultState();
let currentResult: SolveResult | null = null;
let sensitivityResult: SensitivityResult | null = null;
let sensitivitySelection: number | null = null;
const layoutDisplay = { dimensions: false, clearance: false };
let running = false;
let modeller: ShapeModeller | null = null;
let status: { tone: "neutral" | "working" | "success" | "error"; message: string } = { tone: "neutral", message: "Ready" };

root.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">OL</span><div><strong>OpenLayout</strong><small>packing studio</small></div></div>
    <nav class="view-switch"><button id="nav-studio" class="active">Packing</button><button id="nav-modeller">Shape modeller</button></nav>
    <div class="run-actions">
      <progress id="solve-progress" max="100" value="0" hidden aria-label="Packing solve progress"></progress>
      <span id="status" class="status neutral">Ready</span>
      <button id="validate" class="button ghost">Validate</button>
      <button id="cancel" class="button danger" disabled>Stop</button>
      <button id="solve" class="button primary">Run packing</button>
    </div>
  </header>
  <div class="workspace">
    <aside id="editor" class="editor"></aside>
    <main class="results">
      <section class="layout-panel panel">
        <div class="panel-heading"><div><small>LIVE LAYOUT</small><h1 id="layout-title">Problem preview</h1></div><div class="layout-tools"><label><input id="toggle-dimensions" type="checkbox"> Dimensions</label><label><input id="toggle-clearance" type="checkbox"> Clearance</label><div id="layout-id" class="layout-id">not solved</div></div></div>
        <canvas id="layout-canvas" aria-label="Packing layout"></canvas>
        <div id="metrics" class="metrics"></div>
      </section>
      <section class="analysis-grid">
        <div class="panel sensitivity-panel">
          <div class="panel-heading"><div><small>PARAMETER STUDY</small><h2>Capacity transitions</h2></div><div class="study-run"><div id="study-progress" class="study-progress" hidden><progress max="100" value="0" aria-label="Sensitivity study progress"></progress><span aria-live="polite">Preparing…</span></div><button id="run-study" class="button secondary">Run study</button></div></div>
          <div id="sensitivity-scroll" class="sensitivity-scroll"><canvas id="sensitivity-canvas" tabindex="0" aria-label="Sensitivity capacity chart. Click a point to inspect its layout."></canvas></div>
          <div id="transitions" class="transition-list"></div>
        </div>
        <div class="panel diagnostics-panel">
          <div class="panel-heading"><div><small>ENGINE OUTPUT</small><h2>Diagnostics</h2></div><button id="copy-result" class="text-button">Copy JSON</button></div>
          <div id="diagnostics" class="diagnostics"><p>Run a solve to inspect validation and search statistics.</p></div>
        </div>
      </section>
    </main>
  </div>
  <div id="modeller-page" class="modeller-page" hidden></div>`;

const editor = element<HTMLDivElement>("editor");
const layoutCanvas = element<HTMLCanvasElement>("layout-canvas");
const sensitivityCanvas = element<HTMLCanvasElement>("sensitivity-canvas");

renderEditor();
refreshPreview();
window.addEventListener("resize", () => refreshCanvases());

element("solve").addEventListener("click", () => void solve());
element("validate").addEventListener("click", () => void validate());
element("cancel").addEventListener("click", cancel);
element("run-study").addEventListener("click", () => void runStudy());
element("copy-result").addEventListener("click", () => void copyResult());
element("nav-studio").addEventListener("click", closeModeller);
element("nav-modeller").addEventListener("click", () => openModeller(0));
element<HTMLInputElement>("toggle-dimensions").addEventListener("change", (event) => { layoutDisplay.dimensions = (event.target as HTMLInputElement).checked; refreshPreview(); });
element<HTMLInputElement>("toggle-clearance").addEventListener("change", (event) => { layoutDisplay.clearance = (event.target as HTMLInputElement).checked; refreshPreview(); });
sensitivityCanvas.addEventListener("click", (event) => {
  if (!sensitivityResult) return;
  selectSensitivityEvaluation(sensitivityValueAt(sensitivityCanvas, sensitivityResult, event.clientX), "graph");
});
element("sensitivity-scroll").addEventListener("wheel", (event) => {
  const scroll = event.currentTarget as HTMLElement;
  if (scroll.scrollWidth <= scroll.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  scroll.scrollLeft += event.deltaY; event.preventDefault();
}, { passive: false });

function renderEditor(): void {
  editor.innerHTML = `
    <details open><summary>Container regions <span>${state.containerParts.length} Boolean part${state.containerParts.length === 1 ? "" : "s"}</span></summary>
      <div class="section-body stack">
        ${state.containerParts.map(containerPartHtml).join("")}
        <div class="inline-actions"><button class="button add" data-action="add-container-add">+ Add material</button><button class="button add" data-action="add-container-subtract">− Add cut-out</button></div>
      </div>
    </details>
    <details open><summary>Item shapes <span>${state.items.length} definition${state.items.length === 1 ? "" : "s"}</span></summary>
      <div class="section-body stack">
        ${state.items.map(itemEditorHtml).join("")}
        <button class="button add full" data-action="add-item">+ Add item definition</button>
      </div>
    </details>
    <details><summary>Exclusions & fixed items <span>${state.exclusions.length} region${state.exclusions.length === 1 ? "" : "s"}</span></summary>
      <div class="section-body stack">
        ${state.exclusions.map(exclusionHtml).join("")}
        <button class="button add full" data-action="add-exclusion">+ Add exclusion</button>
        <h3>Fixed placements</h3>
        ${state.fixedPlacements.map(fixedHtml).join("") || '<p class="hint">No fixed placements.</p>'}
        <button class="button add full" data-action="add-fixed">+ Add fixed placement</button>
      </div>
    </details>
    <details open><summary>Clearance <span>geometry constraints</span></summary>
      <div class="section-body field-grid three">
        ${numberField("Item ↔ item", "clearance", "item_to_item", state.clearance.item_to_item, 0.05)}
        ${numberField("Item ↔ boundary", "clearance", "item_to_boundary", state.clearance.item_to_boundary, 0.05)}
        ${numberField("Item ↔ exclusion", "clearance", "item_to_exclusion", state.clearance.item_to_exclusion, 0.05)}
      </div>
    </details>
    <details open><summary>Run configuration <span>deterministic worker</span></summary>
      <div class="section-body field-grid two">
        ${numberField("Seed", "option", "seed", state.options.seed, 1)}
        ${numberField("Base iterations", "option", "max_iterations", state.options.max_iterations, 1000)}
        ${numberField("Grid step", "option", "grid_step", state.options.grid_step, 0.1)}
        ${numberField("Restarts", "option", "restarts", state.options.restarts, 1)}
        <label>Quality<select data-scope="option" data-field="quality"><option value="fast" ${state.options.quality === "fast" ? "selected" : ""}>Fast preview</option><option value="balanced" ${state.options.quality === "balanced" ? "selected" : ""}>Balanced</option><option value="thorough" ${state.options.quality === "thorough" ? "selected" : ""}>Thorough</option></select></label>
        <p class="hint wide">Browser runs are iteration-bounded and reproducible. Thorough mode uses four times the base budget and reserves time for every portfolio strategy; Stop terminates and safely recreates the worker.</p>
      </div>
    </details>
    <details><summary>Sensitivity setup <span>${state.study.strategy}</span></summary>
      <div class="section-body field-grid two">
        <label class="wide">Parameter<select id="study-parameter">${parameterOptions()}</select></label>
        ${numberField("Start", "study", "start", state.study.start, 0.1)}
        ${numberField("End", "study", "end", state.study.end, 0.1)}
        ${numberField("Initial step", "study", "initial_step", state.study.initial_step, 0.05)}
        ${numberField("Transition tolerance", "study", "transition_tolerance", state.study.transition_tolerance, 0.01)}
        <label>Sampling<select id="study-strategy"><option value="adaptive" ${state.study.strategy === "adaptive" ? "selected" : ""}>Adaptive refinement</option><option value="sampled" ${state.study.strategy === "sampled" ? "selected" : ""}>Sampled sweep</option></select></label>
        <label>Seed policy<select id="seed-policy"><option value="fixed" ${state.study.seed_policy === "fixed" ? "selected" : ""}>Fixed</option><option value="derive_from_value" ${state.study.seed_policy === "derive_from_value" ? "selected" : ""}>Derive per value</option></select></label>
      </div>
    </details>
    <details><summary>Problem JSON <span>import / export</span></summary>
      <div class="section-body"><textarea id="problem-json" rows="10" spellcheck="false">${escapeHtml(JSON.stringify(toProblem(state), null, 2))}</textarea><div class="inline-actions"><button class="button ghost" data-action="load-json">Load JSON</button><button class="button ghost" data-action="copy-problem">Copy JSON</button></div></div>
    </details>`;
  bindEditor();
  requestAnimationFrame(renderItemPreviews);
}

function itemEditorHtml(item: EditorItem, itemIndex: number): string {
  return `<article class="shape-card">
    <div class="card-heading"><strong>Item ${itemIndex + 1}</strong><div class="card-actions"><button class="text-button" data-action="model-item" data-item="${itemIndex}">Open modeller</button><button class="icon-button" data-action="delete-item" data-item="${itemIndex}" title="Delete item">×</button></div></div>
    <div class="field-grid three">
      ${textField("ID", "item", "id", item.id, itemIndex)}
      ${numberField("Quantity", "item", "quantity", item.quantity, 1, false, itemIndex)}
      <label>Rotation search<select data-scope="item" data-field="rotationMode" data-index="${itemIndex}"><option value="continuous" ${item.rotationMode === "continuous" ? "selected" : ""}>Adaptive 360°</option><option value="discrete" ${item.rotationMode === "discrete" ? "selected" : ""}>Fixed angles</option></select></label>
      <label>Angle coupling<select data-scope="item" data-field="rotationCoupling" data-index="${itemIndex}"><option value="independent" ${item.rotationCoupling === "independent" ? "selected" : ""}>Independent copies</option><option value="shared_per_item" ${item.rotationCoupling === "shared_per_item" ? "selected" : ""}>Shared per item</option></select></label>
      ${item.rotationMode === "discrete" ? textField("Angles", "item", "rotations", item.rotations, itemIndex) : `${numberField("Minimum°", "item", "minRotation", item.minRotation, 1, false, itemIndex)}${numberField("Maximum°", "item", "maxRotation", item.maxRotation, 1, false, itemIndex)}`}
    </div>
    <canvas class="item-preview" data-preview-item="${itemIndex}" aria-label="${escapeHtml(item.id)} shape preview"></canvas>
    <div class="part-stack">${item.parts.map((part, partIndex) => primitiveHtml(part, itemIndex, partIndex)).join("")}</div>
    <div class="primitive-buttons"><span>Add part</span>${(["rectangle", "triangle", "circle", "polygon", "bezier"] as const).map((kind) => `<button data-action="add-part" data-kind="${kind}" data-item="${itemIndex}">${kind}</button>`).join("")}</div>
  </article>`;
}

function containerPartHtml(entry: EditorState["containerParts"][number], index: number): string {
  return `<article class="shape-card compact"><div class="card-heading"><strong>${escapeHtml(entry.id)}</strong><span>${entry.operation === "add" ? "ADD MATERIAL" : "SUBTRACT CUT-OUT"}</span><div class="card-actions"><button class="text-button" data-action="model-container" data-container="${index}">Edit visually</button><button class="icon-button" data-action="delete-container" data-container="${index}">×</button></div></div><div class="field-grid three">${textField("ID", "container", "id", entry.id, index)}<label>Operation<select data-scope="container" data-field="operation" data-index="${index}"><option value="add" ${entry.operation === "add" ? "selected" : ""}>Add</option><option value="subtract" ${entry.operation === "subtract" ? "selected" : ""}>Subtract</option></select></label><span class="hint">${entry.primitive.kind} · x ${format(entry.primitive.x)} · y ${format(entry.primitive.y)} · ${format(entry.primitive.rotation)}°</span></div></article>`;
}

function primitiveHtml(part: PrimitiveEditor, itemIndex: number, partIndex: number): string {
  const dimensions = part.kind === "rectangle"
    ? `${partNumber("Width", "width", part.width, itemIndex, partIndex)}${partNumber("Height", "height", part.height, itemIndex, partIndex)}`
    : part.kind === "triangle"
      ? `${partNumber("Base", "base", part.base, itemIndex, partIndex)}${partNumber("Height", "height", part.height, itemIndex, partIndex)}`
      : part.kind === "circle"
        ? `${partNumber("Radius", "radius", part.radius, itemIndex, partIndex)}${partNumber("Segments", "segments", part.segments, itemIndex, partIndex, 1)}`
        : part.kind === "polygon"
          ? `<label class="wide">Vertices<textarea rows="3" data-scope="part-points" data-item="${itemIndex}" data-part="${partIndex}">${pointText(part.vertices)}</textarea></label>`
          : `${partNumber("Curve segments", "segments", part.segments, itemIndex, partIndex, 1)}<p class="hint wide">Edit Bézier knots and handles in the Shape modeller.</p>`;
  return `<div class="part-card"><div class="part-title"><span class="shape-icon ${part.kind}"></span><strong>${capitalize(part.kind)}</strong><button class="icon-button small" data-action="delete-part" data-item="${itemIndex}" data-part="${partIndex}">×</button></div><div class="field-grid part-fields">${dimensions}${partNumber("X", "x", part.x, itemIndex, partIndex)}${partNumber("Y", "y", part.y, itemIndex, partIndex)}${partNumber("Rotation°", "rotation", part.rotation, itemIndex, partIndex)}</div></div>`;
}

function exclusionHtml(entry: EditorExclusion, index: number): string {
  const part = entry.primitive;
  const shapeFields = part.kind === "circle"
    ? `${exclusionNumber("Radius", "radius", part.radius, index)}${exclusionNumber("Segments", "segments", part.segments, index, 1)}`
    : part.kind === "rectangle"
      ? `${exclusionNumber("Width", "width", part.width, index)}${exclusionNumber("Height", "height", part.height, index)}`
      : part.kind === "triangle"
        ? `${exclusionNumber("Base", "base", part.base, index)}${exclusionNumber("Height", "height", part.height, index)}`
      : part.kind === "polygon" ? `<label class="wide">Vertices<textarea rows="3" data-scope="exclusion-points" data-exclusion="${index}">${pointText(part.vertices)}</textarea></label>`
        : `<p class="hint wide">Edit Bézier knots in the Shape modeller.</p>`;
  return `<article class="shape-card compact"><div class="card-heading"><strong>${escapeHtml(entry.id)}</strong><div class="card-actions"><button class="text-button" data-action="model-exclusion" data-exclusion="${index}">Edit visually</button><button class="icon-button" data-action="delete-exclusion" data-exclusion="${index}">×</button></div></div><div class="field-grid three">${textField("ID", "exclusion", "id", entry.id, index)}${numberField("Clearance", "exclusion", "clearance", entry.clearance, .05, false, index)}<label>Shape<select data-scope="exclusion-kind" data-exclusion="${index}">${(["rectangle", "triangle", "circle", "polygon"] as const).map((kind) => `<option ${part.kind === kind ? "selected" : ""}>${kind}</option>`).join("")}</select></label>${shapeFields}${exclusionNumber("X", "x", part.x, index)}${exclusionNumber("Y", "y", part.y, index)}${exclusionNumber("Rotation°", "rotation", part.rotation, index)}</div></article>`;
}

function fixedHtml(entry: EditorState["fixedPlacements"][number], index: number): string {
  return `<div class="fixed-row"><label>Item<select data-scope="fixed" data-index="${index}" data-field="item_id">${state.items.map((item) => `<option ${item.id === entry.item_id ? "selected" : ""}>${escapeHtml(item.id)}</option>`).join("")}</select></label>${fixedNumber("X", "x", entry.x, index)}${fixedNumber("Y", "y", entry.y, index)}${fixedNumber("Rotation", "rotation_deg", entry.rotation_deg, index)}<button class="icon-button" data-action="delete-fixed" data-index="${index}">×</button></div>`;
}

function bindEditor(): void {
  editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-scope]").forEach((input) => input.addEventListener("change", () => {
    if (input.dataset.scope === "study") {
      updateScopedInput(input); sensitivityResult = null; sensitivitySelection = null; element("study-progress").hidden = true; renderSensitivity(sensitivityCanvas, null); setStatus("neutral", "Study configuration changed");
    } else {
      mutate(() => updateScopedInput(input), input.dataset.scope === "exclusion-kind");
    }
  }));
  element<HTMLSelectElement>("study-parameter").addEventListener("change", (event) => { state.study.parameterKey = (event.target as HTMLSelectElement).value; });
  element<HTMLSelectElement>("study-strategy").addEventListener("change", (event) => { state.study.strategy = (event.target as HTMLSelectElement).value as "adaptive" | "sampled"; });
  element<HTMLSelectElement>("seed-policy").addEventListener("change", (event) => { state.study.seed_policy = (event.target as HTMLSelectElement).value as "fixed" | "derive_from_value"; });
  editor.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button)));
}

function updateScopedInput(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const scope = input.dataset.scope!;
  const field = input.dataset.field!;
  const value: string | number = input instanceof HTMLInputElement && input.type === "number" ? Number(input.value) : input.value;
  if (scope === "clearance") setField(state.clearance, field, value);
  else if (scope === "container") setField(state.containerParts[Number(input.dataset.index)], field, value);
  else if (scope === "option") setField(state.options, field, field === "time_limit_ms" && state.options.deterministic ? null : value);
  else if (scope === "study") setField(state.study, field, value);
  else if (scope === "item") setField(state.items[Number(input.dataset.index)], field, value);
  else if (scope === "part") setField(state.items[Number(input.dataset.item)].parts[Number(input.dataset.part)], field, value);
  else if (scope === "part-points") {
    const part = state.items[Number(input.dataset.item)].parts[Number(input.dataset.part)];
    if (part.kind === "polygon") part.vertices = parsePointText(String(value));
  } else if (scope === "exclusion") setField(state.exclusions[Number(input.dataset.index)], field, value);
  else if (scope === "exclusion-part") setField(state.exclusions[Number(input.dataset.exclusion)].primitive, field, value);
  else if (scope === "exclusion-points") {
    const part = state.exclusions[Number(input.dataset.exclusion)].primitive;
    if (part.kind === "polygon") part.vertices = parsePointText(String(value));
  } else if (scope === "exclusion-kind") {
    const index = Number(input.dataset.exclusion);
    const previous = state.exclusions[index].primitive;
    const next = makePrimitive(value as PrimitiveEditor["kind"]);
    next.x = previous.x; next.y = previous.y; next.rotation = previous.rotation;
    state.exclusions[index].primitive = next;
  } else if (scope === "fixed") setField(state.fixedPlacements[Number(input.dataset.index)], field, value);
}

function handleAction(button: HTMLButtonElement): void {
  const action = button.dataset.action;
  if (action === "model-item") { openModeller(Number(button.dataset.item)); return; }
  if (action === "model-container") { openModeller(`container:${button.dataset.container ?? 0}`); return; }
  if (action === "model-exclusion") { openModeller(`exclusion:${button.dataset.exclusion}`); return; }
  mutate(() => {
    if (action === "add-item") state.items.push({ id: uniqueId("item", state.items.map((item) => item.id)), quantity: 50, rotationMode: "continuous", rotationCoupling: "independent", rotations: "0, 90", minRotation: 0, maxRotation: 360, parts: [makePrimitive("rectangle")] });
    else if (action === "add-container-add" || action === "add-container-subtract") {
      const operation = action === "add-container-add" ? "add" : "subtract";
      const primitive = makePrimitive("rectangle"); primitive.x = 15; primitive.y = 9;
      state.containerParts.push({ id: uniqueId(operation === "add" ? "material" : "cutout", state.containerParts.map((entry) => entry.id)), operation, primitive });
    }
    else if (action === "delete-container") {
      const index = Number(button.dataset.container), entry = state.containerParts[index];
      if (entry.operation === "add" && state.containerParts.filter((part) => part.operation === "add").length === 1) throw new Error("The container requires at least one additive region");
      state.containerParts.splice(index, 1);
    }
    else if (action === "delete-item") state.items.splice(Number(button.dataset.item), 1);
    else if (action === "add-part") state.items[Number(button.dataset.item)].parts.push(makePrimitive(button.dataset.kind as PrimitiveEditor["kind"]));
    else if (action === "delete-part") {
      const parts = state.items[Number(button.dataset.item)].parts; const [deleted] = parts.splice(Number(button.dataset.part), 1);
      parts.forEach((part) => { if (part.snap?.targetId === deleted?.id) delete part.snap; });
    }
    else if (action === "add-exclusion") state.exclusions.push({ id: uniqueId("exclusion", state.exclusions.map((entry) => entry.id)), clearance: 0, primitive: { ...makePrimitive("rectangle"), x: 10, y: 8 } });
    else if (action === "delete-exclusion") state.exclusions.splice(Number(button.dataset.exclusion), 1);
    else if (action === "add-fixed") state.fixedPlacements.push({ item_id: state.items[0]?.id ?? "", x: 2, y: 2, rotation_deg: 0 });
    else if (action === "delete-fixed") state.fixedPlacements.splice(Number(button.dataset.index), 1);
    else if (action === "load-json") {
      const problem = JSON.parse(element<HTMLTextAreaElement>("problem-json").value) as PackingProblem;
      const options = state.options, study = state.study;
      state = fromProblem(problem); state.options = options; state.study = study;
    } else if (action === "copy-problem") void navigator.clipboard.writeText(JSON.stringify(toProblem(state), null, 2));
  }, action !== "copy-problem");
}

async function solve(): Promise<void> {
  if (running) return;
  try {
    const problem = toProblem(state);
    setRunning(true, "Preparing geometry…");
    currentResult = null;
    const result = await client.solve(problem, state.options, (progress) => updateProgress(problem, progress));
    currentResult = result;
    setStatus("success", `${result.packed_item_count} items · ${humanStatus(result.status)}`);
    showResult(problem, result);
  } catch (error) { handleRunError(error); } finally { setRunning(false); }
}

async function validate(): Promise<void> {
  try { setStatus("working", "Validating geometry…"); await client.validate(toProblem(state)); setStatus("success", "Problem geometry is valid"); }
  catch (error) { setStatus("error", errorMessage(error)); }
}

async function runStudy(): Promise<void> {
  if (running) return;
  try {
    const problem = toProblem(state);
    const study = buildStudy();
    setRunning(true, "Running parameter study…");
    sensitivitySelection = null;
    resetStudyProgress();
    sensitivityResult = await client.sensitivity(problem, study, updateStudyProgress);
    sensitivitySelection = sensitivityResult.evaluations[0]?.value ?? null;
    renderSensitivity(sensitivityCanvas, sensitivityResult, sensitivitySelection);
    renderTransitions();
    completeStudyProgress(sensitivityResult.evaluations.length);
    setStatus("success", `${sensitivityResult.evaluations.length} parameter values evaluated`);
  } catch (error) { handleRunError(error); } finally { setRunning(false); }
}

function cancel(): void { if (!running) return; client.cancel(); setRunning(false); element("study-progress").hidden = true; setStatus("neutral", "Run cancelled; worker restarted"); }

function resetStudyProgress(): void {
  const container = element("study-progress"), progress = container.querySelector("progress")!;
  container.hidden = false; progress.max = 100; progress.value = 0;
  container.querySelector("span")!.textContent = "Preparing…";
}

function updateStudyProgress(value: SensitivityProgress): void {
  const container = element("study-progress"), progress = container.querySelector("progress")!;
  container.hidden = false;
  if (value.phase === "sampling") {
    progress.value = Math.min(100, value.completed / Math.max(value.initial_total, 1) * (state.study.strategy === "adaptive" ? 72 : 100));
    container.querySelector("span")!.textContent = `${value.completed}/${value.initial_total} sampled · ${format(value.value)}`;
  } else {
    progress.removeAttribute("value");
    container.querySelector("span")!.textContent = `Refining transitions · ${value.completed} points`;
  }
  setStatus("working", `${value.completed} parameter values evaluated · capacity ${value.capacity}`);
}

function completeStudyProgress(count: number): void {
  const container = element("study-progress"), progress = container.querySelector("progress")!;
  progress.value = 100; container.querySelector("span")!.textContent = `${count} points complete`;
}

function updateProgress(problem: PackingProblem, progress: SolveProgress): void {
  element<HTMLProgressElement>("solve-progress").value = Math.round(progress.completed_fraction * 100);
  setStatus("working", `${humanStatus(progress.phase)} · ${progress.packed_item_count} placed · ${Math.round(progress.completed_fraction * 100)}%`);
  renderLayout(layoutCanvas, problem, progress.placements, layoutDisplay);
  element("layout-title").textContent = `Improving · ${progress.packed_item_count} items`;
  element("layout-id").textContent = progress.solver_strategy;
}

function showResult(problem: PackingProblem, result: SolveResult): void {
  renderLayout(layoutCanvas, problem, result.placements, layoutDisplay);
  element("layout-title").textContent = `${result.packed_item_count} packed items`;
  element("layout-id").textContent = result.layout_id;
  element("metrics").innerHTML = metricHtml("Packed", result.packed_item_count) + metricHtml("Upper bound", result.simple_upper_bound ?? "—") + metricHtml("Candidates", result.statistics.candidates_evaluated.toLocaleString()) + metricHtml("Elapsed", `${result.statistics.elapsed_ms} ms`) + metricHtml("Validation", result.validation.valid ? "Passed" : "Failed");
  element("diagnostics").innerHTML = `<dl><dt>Status</dt><dd>${humanStatus(result.status)}</dd><dt>Strategy</dt><dd>${escapeHtml(result.solver_strategy)}</dd><dt>Seed</dt><dd>${result.seed}</dd><dt>Iterations</dt><dd>${result.statistics.iterations.toLocaleString()}</dd><dt>Valid candidates</dt><dd>${result.statistics.valid_candidates.toLocaleString()}</dd><dt>Counts</dt><dd>${Object.entries(result.packed_count_by_item).map(([key, value]) => `${escapeHtml(key)}: ${value}`).join(" · ")}</dd></dl>${result.warnings.length ? `<div class="warning">${result.warnings.map(escapeHtml).join("<br>")}</div>` : '<div class="validation-ok">✓ Independent final validation passed</div>'}`;
}

function renderTransitions(): void {
  const container = element("transitions");
  if (!sensitivityResult) { container.innerHTML = ""; return; }
  container.innerHTML = sensitivityResult.transitions.map((transition) => `<article class="transition"><header><strong>${transition.lower_capacity} → ${transition.upper_capacity}</strong><span>${format(transition.lower_value)}–${format(transition.upper_value)}</span></header><div><button data-value="${transition.lower_value}" title="Inspect the last evaluated point before this transition"><b>Before</b><span>${transition.lower_capacity} items @ ${format(transition.lower_value)}</span></button><button data-value="${transition.upper_value}" title="Inspect the first evaluated point after this transition"><b>After</b><span>${transition.upper_capacity} items @ ${format(transition.upper_value)}</span></button></div></article>`).join("") || '<p class="hint">No capacity change was observed in this interval. Click any graph point to inspect its layout.</p>';
  container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", () => selectSensitivityEvaluation(Number(button.dataset.value), button.querySelector("b")!.textContent!.toLowerCase())));
  if (sensitivityResult.warnings.length) container.insertAdjacentHTML("beforeend", `<div class="warning">${sensitivityResult.warnings.map(escapeHtml).join("<br>")}</div>`);
}

function selectSensitivityEvaluation(value: number, side: string): void {
  if (!sensitivityResult) return;
  const evaluation = sensitivityResult.evaluations.reduce((best, entry) => Math.abs(entry.value - value) < Math.abs(best.value - value) ? entry : best);
  sensitivitySelection = evaluation.value;
  currentResult = evaluation.result;
  renderSensitivity(sensitivityCanvas, sensitivityResult, evaluation.value);
  showResult(evaluation.problem, evaluation.result);
  element("transitions").querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.value) === evaluation.value));
  setStatus("neutral", `Viewing ${side} point ${format(evaluation.value)} · ${evaluation.capacity} items`);
}

function buildStudy(): SensitivityStudy {
  return {
    parameter: decodeParameter(state.study.parameterKey),
    start: state.study.start, end: state.study.end, initial_step: state.study.initial_step,
    transition_tolerance: state.study.transition_tolerance, strategy: state.study.strategy,
    solve_options: state.options, seed_policy: state.study.seed_policy,
    increasing_is_harder: state.study.increasing_is_harder,
  };
}

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
  if (kind === "clearance_item_to_item") return { kind };
  if (kind === "clearance_item_to_boundary") return { kind };
  if (kind === "container_width") return { kind };
  return { kind: "container_height" };
}

function parameterOptions(): string {
  const options: Array<[string, string]> = [];
  state.items.forEach((item) => {
    options.push([`item_scale:${item.id}`, `${item.id} · whole shape scale`]);
    options.push([`item_quantity:${item.id}`, `${item.id} · quantity`]);
    item.parts.forEach((part, index) => {
      options.push([`part_scale:${item.id}:${index}`, `${item.id} · part ${index + 1} scale`]);
      if (part.kind === "rectangle" || part.kind === "triangle" || part.kind === "polygon" || part.kind === "bezier") {
        options.push([`part_width:${item.id}:${index}`, `${item.id} · part ${index + 1} width/base`]);
        options.push([`part_height:${item.id}:${index}`, `${item.id} · part ${index + 1} height`]);
      }
      if (part.kind === "circle") options.push([`part_radius:${item.id}:${index}`, `${item.id} · part ${index + 1} radius`]);
    });
  });
  state.containerParts.forEach((part) => {
    options.push([`container_part_scale:${part.id}`, `${part.id} · scale`]);
    options.push([`container_part_width:${part.id}`, `${part.id} · width`]);
    options.push([`container_part_height:${part.id}`, `${part.id} · height`]);
  });
  options.push(["clearance_item_to_item", "Item-to-item clearance"], ["clearance_item_to_boundary", "Boundary clearance"], ["container_width", "Container width"], ["container_height", "Container height"]);
  state.exclusions.forEach((entry) => options.push([`exclusion_scale:${entry.id}`, `${entry.id} · scale`]));
  if (!options.some(([value]) => value === state.study.parameterKey)) state.study.parameterKey = options[0]?.[0] ?? "container_width";
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${state.study.parameterKey === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function mutate(change: () => void, rerender = true): void {
  try { change(); currentResult = null; sensitivityResult = null; sensitivitySelection = null; element("study-progress").hidden = true; if (rerender) renderEditor(); else element<HTMLTextAreaElement>("problem-json").value = JSON.stringify(toProblem(state), null, 2); refreshPreview(); setStatus("neutral", "Problem changed"); }
  catch (error) { setStatus("error", errorMessage(error)); }
}

function refreshPreview(): void {
  try { renderLayout(layoutCanvas, toProblem(state), currentResult?.placements ?? [], layoutDisplay); renderSensitivity(sensitivityCanvas, sensitivityResult, sensitivitySelection); renderItemPreviews(); }
  catch (error) { setStatus("error", errorMessage(error)); }
}
function renderItemPreviews(): void {
  const problem = toProblem(state);
  editor.querySelectorAll<HTMLCanvasElement>("[data-preview-item]").forEach((canvas) => {
    const item = problem.items[Number(canvas.dataset.previewItem)];
    if (item) renderShapePreview(canvas, item.shape);
  });
}
function refreshCanvases(): void { refreshPreview(); }

function openModeller(target: number | string): void {
  if (typeof target === "number" && !state.items[target]) return;
  if (typeof target === "string" && target.startsWith("exclusion:") && !state.exclusions[Number(target.split(":")[1])]) return;
  if (typeof target === "string" && target.startsWith("container:") && !state.containerParts[Number(target.split(":")[1])]) return;
  element("modeller-page").hidden = false;
  document.querySelector<HTMLElement>(".workspace")!.hidden = true;
  document.querySelector<HTMLElement>(".run-actions")!.hidden = true;
  element("nav-studio").classList.remove("active"); element("nav-modeller").classList.add("active");
  modeller = new ShapeModeller(element("modeller-page"), state, target, () => {
    currentResult = null; sensitivityResult = null; setStatus("neutral", "Problem geometry changed");
  }, closeModeller);
}

function closeModeller(): void {
  if (!modeller && element("modeller-page").hidden) return;
  modeller?.destroy(); modeller = null; element("modeller-page").hidden = true; document.querySelector<HTMLElement>(".workspace")!.hidden = false;
  document.querySelector<HTMLElement>(".run-actions")!.hidden = false; element("nav-studio").classList.add("active"); element("nav-modeller").classList.remove("active");
  renderEditor(); refreshPreview();
}

function setRunning(value: boolean, message?: string): void {
  running = value; element<HTMLButtonElement>("solve").disabled = value; element<HTMLButtonElement>("run-study").disabled = value; element<HTMLButtonElement>("cancel").disabled = !value;
  const solveProgress = element<HTMLProgressElement>("solve-progress"); solveProgress.hidden = !value; if (value) solveProgress.value = 0;
  if (message) setStatus("working", message);
}
function setStatus(tone: typeof status.tone, message: string): void { status = { tone, message }; const node = element("status"); node.className = `status ${tone}`; node.textContent = message; }
function handleRunError(error: unknown): void { if (errorMessage(error) !== "Run cancelled") setStatus("error", errorMessage(error)); }
async function copyResult(): Promise<void> { await navigator.clipboard.writeText(JSON.stringify(currentResult ?? sensitivityResult ?? {}, null, 2)); setStatus("success", "Output copied"); }

function numberField(label: string, scope: string, field: string, value: number, step: number, disabled = false, index?: number): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-scope="${scope}" data-field="${field}" ${index === undefined ? "" : `data-index="${index}"`} ${disabled ? "disabled" : ""}></label>`; }
function textField(label: string, scope: string, field: string, value: string, index: number): string { return `<label>${label}<input value="${escapeHtml(value)}" data-scope="${scope}" data-field="${field}" data-index="${index}"></label>`; }
function partNumber(label: string, field: string, value: number, item: number, part: number, step = .1): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-scope="part" data-field="${field}" data-item="${item}" data-part="${part}"></label>`; }
function exclusionNumber(label: string, field: string, value: number, exclusion: number, step = .1): string { return `<label>${label}<input type="number" value="${value}" step="${step}" data-scope="exclusion-part" data-field="${field}" data-exclusion="${exclusion}"></label>`; }
function fixedNumber(label: string, field: string, value: number, index: number): string { return `<label>${label}<input type="number" value="${value}" step=".1" data-scope="fixed" data-field="${field}" data-index="${index}"></label>`; }
function metricHtml(label: string, value: string | number): string { return `<div><small>${label}</small><strong>${value}</strong></div>`; }
function setField(target: object, field: string, value: unknown): void { (target as Record<string, unknown>)[field] = value; }
function uniqueId(prefix: string, ids: string[]): string { let index = 1; while (ids.includes(`${prefix}-${index}`)) index++; return `${prefix}-${index}`; }
function humanStatus(value: string): string { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, ""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!); }
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
