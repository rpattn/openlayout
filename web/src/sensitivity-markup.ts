import type { ParameterChoice } from "./sensitivity-model";
import type { EditorState, SensitivityResult, SolveResult } from "./types";
import { escapeHtml, formatNumber, humanize } from "./ui-utils";

export function sensitivitySidebarHtml(state: EditorState, parameterOptions: string, selected: ParameterChoice | undefined, currentValue: number): string {
  return `<div class="side-heading"><div><small>SENSITIVITY</small><h2>Study configuration</h2></div><span>${state.study.strategy}</span></div>
    <section class="sidebar-section parameter-picker"><small>1 · CHOOSE WHAT CHANGES</small>
      <label class="wide parameter-search">Find a variable<input id="study-parameter-search" type="search" placeholder="Try width, clearance, radius…" autocomplete="off"></label>
      <div id="study-parameter-matches" class="parameter-matches"></div>
      <label class="wide">Selected variable<select id="study-parameter">${parameterOptions}</select></label>
      <div id="study-parameter-summary" class="parameter-summary"><span>${escapeHtml(selected?.group ?? "Geometry")}</span><strong>${escapeHtml(selected?.label ?? state.study.parameterKey)}</strong><small>Current value ${formatNumber(currentValue)}</small></div>
      <button id="suggest-study-range" type="button" class="button ghost full">Set a useful range around current value</button>
    </section>
    <section class="sidebar-section"><small>2 · SET RANGE & METHOD</small><div class="field-grid two study-range-grid">
      ${studyNumber("Start", "start", state.study.start, .1)}${studyNumber("End", "end", state.study.end, .1)}
      ${studyNumber("Initial step", "initial_step", state.study.initial_step, .05)}${studyNumber("Tolerance", "transition_tolerance", state.study.transition_tolerance, .01)}
      <label>Sampling<select id="study-strategy"><option value="adaptive" ${state.study.strategy === "adaptive" ? "selected" : ""}>Adaptive refinement</option><option value="sampled" ${state.study.strategy === "sampled" ? "selected" : ""}>Sampled sweep</option></select></label>
      <label>Seed policy<select id="seed-policy"><option value="fixed" ${state.study.seed_policy === "fixed" ? "selected" : ""}>Fixed</option><option value="derive_from_value" ${state.study.seed_policy === "derive_from_value" ? "selected" : ""}>Derive per value</option></select></label>
    </div><button id="run-study" class="button primary full" title="Run sensitivity study (R)">Run sensitivity study</button></section>`;
}

export function parameterMatchesHtml(matches: Array<ParameterChoice & { currentValue: number }>): string {
  return matches.map((entry) => `<button type="button" data-parameter-key="${escapeHtml(entry.key)}"><span>${escapeHtml(entry.group)}</span><strong>${escapeHtml(entry.label)}</strong><small>${formatNumber(entry.currentValue)}</small></button>`).join("") || '<p class="empty-state">No variables match that search.</p>';
}

export function studyStepsHtml(values: number[]): string {
  return values.map((value, index) => `<article class="shape-step ${index === 0 || index === values.length - 1 ? "extreme" : ""}"><header><strong>${formatNumber(value)}</strong><span>${index === 0 ? "START" : index === values.length - 1 ? "END" : `STEP ${index}`}</span></header><canvas data-study-preview="${index}"></canvas></article>`).join("");
}

export function transitionsHtml(result: SensitivityResult | null): string {
  if (!result) return '<p class="empty-state">Run the study to locate capacity transitions.</p>';
  return result.transitions.map((transition) => `<article class="transition"><header><strong>${transition.lower_capacity} → ${transition.upper_capacity}</strong><span>${formatNumber(transition.lower_value)}–${formatNumber(transition.upper_value)}</span></header><div><button data-value="${transition.lower_value}"><b>Before</b><span>${transition.lower_capacity} @ ${formatNumber(transition.lower_value)}</span></button><button data-value="${transition.upper_value}"><b>After</b><span>${transition.upper_capacity} @ ${formatNumber(transition.upper_value)}</span></button></div></article>`).join("") || '<p class="empty-state">No capacity transition was observed.</p>';
}

export function metricsHtml(result: SolveResult): string {
  return metric("Packed", result.packed_item_count)
    + metric("Upper bound", result.simple_upper_bound ?? "—")
    + metric("Candidates", result.statistics.candidates_evaluated.toLocaleString())
    + metric("Elapsed", formatDuration(result.runtime_timing?.total_ms ?? result.statistics.elapsed_ms))
    + metric("Validation", result.validation.valid ? "Passed" : "Failed");
}

export function diagnosticsHtml(result: SolveResult | null, manualLayout: boolean, stale: boolean): string {
  if (!result) return "<p>Run a solve to inspect validation and search statistics.</p>";
  const phases = result.runtime_timing ? Object.entries(result.runtime_timing.phase_ms).map(([phase, elapsed]) => `<dt>${humanize(phase)}</dt><dd>${formatDuration(elapsed ?? 0)}</dd>`).join("") : "";
  const runtime = result.runtime_timing;
  const laneTelemetry = runtime?.lanes?.map((lane) => `<dt>${humanize(lane.lane)} lane</dt><dd>${formatDuration(lane.total_ms)} · startup ${formatDuration(lane.cold_start_ms)} · request ${formatBytes(lane.request_bytes)} · ${lane.callback_count.toLocaleString()} callbacks / ${formatBytes(lane.callback_bytes)} · ${formatBytes(lane.wasm_memory_bytes)} Wasm</dd>`).join("") ?? "";
  const portfolio = runtime?.winning_lane ? `<dt>Winning lane</dt><dd>${humanize(runtime.winning_lane)}</dd><dt>Portfolio history</dt><dd>${runtime.portfolio_runs?.toLocaleString() ?? 1} runs · ${Object.entries(runtime.portfolio_wins ?? {}).map(([lane, wins]) => `${humanize(lane)} ${wins}`).join(" · ")}</dd>` : "";
  const workerTelemetry = runtime && !runtime.lanes ? `<dt>Worker startup</dt><dd>${formatDuration(runtime.cold_start_ms ?? 0)}</dd><dt>Progress transport</dt><dd>${(runtime.callback_count ?? 0).toLocaleString()} callbacks · ${formatBytes(runtime.callback_bytes ?? 0)}</dd><dt>Wasm memory</dt><dd>${formatBytes(runtime.wasm_memory_bytes ?? 0)}</dd>` : "";
  const warning = manualLayout || stale ? `<div class="warning">${stale ? "The problem definition changed after solving. The layout remains visible as a reference, but its validation is stale." : "This result was manually edited after solving. Geometry and collision validation shown below applies to the original solver output."}</div>` : "";
  const validation = result.warnings.length ? `<div class="warning">${result.warnings.map(escapeHtml).join("<br>")}</div>` : '<div class="validation-ok">✓ Independent final validation passed</div>';
  return `${warning}<div class="diagnostic-metrics">${metricsHtml(result)}</div><dl><dt>Status</dt><dd>${humanize(result.status)}</dd><dt>Strategy</dt><dd>${escapeHtml(result.solver_strategy)}</dd><dt>Layout</dt><dd>${result.layout_id}</dd><dt>Seed</dt><dd>${result.seed}</dd><dt>Workers</dt><dd>${result.runtime_timing?.worker_count ?? 1}</dd><dt>Iterations</dt><dd>${result.statistics.iterations.toLocaleString()}</dd><dt>Counts</dt><dd>${Object.entries(result.packed_count_by_item).map(([key, value]) => `${escapeHtml(key)}: ${value}`).join(" · ")}</dd>${phases}${portfolio}${laneTelemetry}${workerTelemetry}</dl>${validation}`;
}

function studyNumber(label: string, field: string, value: number, step: number): string {
  return `<label>${label}<input type="number" value="${value}" step="${step}" data-study-field="${field}"></label>`;
}

function metric(label: string, value: string | number): string {
  return `<div><small>${label}</small><strong>${value}</strong></div>`;
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}
