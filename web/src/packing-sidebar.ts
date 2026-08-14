import type { CadSelection } from "./cad-selection";
import type { EditorState } from "./types";
import type { PackingOutcome } from "./packing-results";
import { escapeHtml, formatNumber, humanize } from "./ui-utils";

interface PackingSidebarContext {
  state: EditorState;
  selection: CadSelection | null;
  selections: CadSelection[];
  lockedSelections: CadSelection[];
  inspectorHtml: string;
  mode: "edit" | "running" | "results";
  outcome: PackingOutcome | null;
  resultWarnings: string[];
  isLocked(selection: CadSelection): boolean;
  selectionLabel(selection: CadSelection): string;
}

export function packingSidebarHtml(context: PackingSidebarContext): string {
  const { state } = context;
  const entityButton = (kind: "container" | "exclusion" | "item", index: number, name: string, meta: string): string => {
    const key = `${kind}:${index}`;
    const selected = context.selections.some((entry) => entry.kind === kind && entry.index === index);
    const title = kind === "item" ? "Item to pack" : kind === "exclusion" ? "Exclusion" : "Container region";
    return `<button class="entity-row ${selected ? "selected" : ""}" data-cad-select="${key}" title="${title}"><canvas data-entity-preview="${key}" aria-hidden="true"></canvas><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(meta)}</small></span></button>`;
  };
  const lockedButton = (value: CadSelection): string => {
    const key = `${value.kind}:${value.index}`;
    const selected = context.selection?.kind === value.kind && context.selection.index === value.index;
    return `<button class="entity-row locked-row ${selected ? "selected" : ""}" data-cad-select="${key}" title="Select or unlock"><span class="locked-entity-icon" aria-hidden="true">⌑</span><span><strong>${escapeHtml(context.selectionLabel(value))}</strong><small>${escapeHtml(selectionKindLabel(state, value))}</small><span class="locked-action" data-unlock-entity>Unlock</span></span></button>`;
  };
  return `<section id="selection-inspector" class="problem-section inspector-section selection-inspector-top">${context.inspectorHtml}</section>
    ${context.outcome ? resultsHtml(context.outcome, context.resultWarnings) : ""}
    <section class="problem-section entity-section workflow-section" data-workflow-section="container">
      <div class="section-title"><div><small>Define</small><h2>Container</h2></div></div>
      <div class="entity-group">${state.containerParts.map((entry, index) => context.isLocked({ kind: "container", index }) ? "" : entityButton("container", index, entry.id, entry.operation === "add" ? "Material" : "Cut-out")).join("")}</div>
      <div class="object-add-row"><button data-add-object="material">+ Material</button><button data-add-object="cutout">+ Cut-out</button></div>
    </section>
    <section class="problem-section entity-section workflow-section" data-workflow-section="items">
      <div class="section-title"><div><small>Define</small><h2>Items to pack</h2></div></div>
      <div class="entity-group">${state.items.map((item, index) => context.isLocked({ kind: "item", index }) ? "" : entityButton("item", index, item.id, `${item.quantity} requested`)).join("")}</div>
      <div class="object-add-row"><button data-add-object="item">+ Item</button></div>
    </section>
    <section class="problem-section entity-section workflow-section" data-workflow-section="constraints">
      <div class="section-title"><div><small>Configure</small><h2>Constraints</h2></div></div>
      <div class="entity-group"><span>Exclusions</span>${state.exclusions.map((entry, index) => context.isLocked({ kind: "exclusion", index }) ? "" : entityButton("exclusion", index, entry.id, `${formatNumber(entry.clearance)} spacing`)).join("") || '<p class="empty-inline">None</p>'}</div>
      ${context.lockedSelections.length ? `<div class="entity-group locked-entity-group"><span>Locked items</span>${context.lockedSelections.map(lockedButton).join("")}</div>` : ""}
      <div class="object-add-row"><button data-add-object="exclusion">+ Exclusion</button></div>
    </section>
    <details class="problem-section settings-section" open><summary>Spacing <span>Constraints</span></summary><div class="details-body field-grid three">
      ${numberField("Item ↔ item", "clearance", "item_to_item", state.clearance.item_to_item, .05)}
      ${numberField("Container edge", "clearance", "item_to_boundary", state.clearance.item_to_boundary, .05)}
      ${numberField("Exclusion", "clearance", "item_to_exclusion", state.clearance.item_to_exclusion, .05)}
    </div></details>
    <details class="problem-section settings-section"><summary>Locked items <span>${state.fixedPlacements.length || "None"}</span></summary><div class="details-body">${fixedPlacementsHtml(state)}</div></details>
    <details class="problem-section settings-section" open><summary>Packing settings <span>${humanize(state.options.quality)}</span></summary><div class="details-body">
      <label class="wide">Packing strategy<select data-pack-scope="option" data-field="quality"><option value="fast" ${state.options.quality === "fast" ? "selected" : ""}>Fast preview</option><option value="balanced" ${state.options.quality === "balanced" ? "selected" : ""}>Balanced</option><option value="thorough" ${state.options.quality === "thorough" ? "selected" : ""}>Thorough</option></select></label>
      <p class="setting-help">Choose faster previews while configuring, or a deeper search for final layouts.</p>
      <details class="advanced-settings"><summary>Advanced settings</summary><div class="field-grid two">
        ${numberField("Seed", "option", "seed", state.options.seed, 1)}${numberField("Base iterations", "option", "max_iterations", state.options.max_iterations, 1000)}
        ${numberField("Grid step", "option", "grid_step", state.options.grid_step, .1)}${numberField("Restarts", "option", "restarts", state.options.restarts, 1)}
        <label class="wide checkbox-field"><input type="checkbox" data-pack-scope="option" data-field="baseline_only" ${state.options.baseline_only ? "checked" : ""}> Baseline only · quick validation</label>
      </div></details>
    </div></details>`;
}

function resultsHtml(outcome: PackingOutcome, warnings: string[]): string {
  const incomplete = outcome.unplaced > 0;
  return `<section class="problem-section results-summary ${incomplete ? "warning" : "complete"}" data-workflow-section="results" aria-live="polite">
    <div class="results-heading"><div><small>Results</small><h2>${outcome.packed} of ${outcome.requested} packed</h2></div><span aria-label="${incomplete ? "Packing incomplete" : "Packing complete"}">${incomplete ? "!" : "✓"}</span></div>
    <div class="result-metrics"><div><strong>${outcome.unplaced}</strong><span>Unplaced</span></div><div><strong>${outcome.completion}%</strong><span>Complete</span></div><div><strong>${formatNumber(outcome.utilisation)}%</strong><span>Material used</span></div></div>
    ${incomplete ? `<p>${outcome.unplaced} could not be placed.</p>` : ""}
    <details class="result-reasons"><summary>See why</summary><div>${outcome.items.map((item) => `<p><strong>${escapeHtml(item.id)}</strong><span>${item.packed}/${item.requested} packed${item.unplaced ? ` · ${item.unplaced} unplaced` : ""}</span></p>`).join("")}${warnings.map((warning) => `<p class="solver-warning">${escapeHtml(warning)}</p>`).join("")}<small>No further valid placements were found with the current geometry, spacing, locked items, and packing strategy.</small></div></details>
  </section>`;
}

function fixedPlacementsHtml(state: EditorState): string {
  const rows = state.fixedPlacements.map((placement, index) => `<div class="fixed-inline-row" data-fixed-row="${index}"><select aria-label="Fixed placement item">${state.items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === placement.item_id ? "selected" : ""}>${escapeHtml(item.id)}</option>`).join("")}</select><input aria-label="Fixed placement X" type="number" step=".1" value="${formatNumber(placement.x)}" data-fixed-field="x"><input aria-label="Fixed placement Y" type="number" step=".1" value="${formatNumber(placement.y)}" data-fixed-field="y"><input aria-label="Fixed placement rotation" type="number" step="1" value="${formatNumber(placement.rotation_deg)}" data-fixed-field="rotation_deg"><button aria-label="Delete fixed placement" data-delete-fixed>×</button></div>`).join("");
  return `<div class="fixed-inline-head"><span>Item</span><span>X</span><span>Y</span><span>Rot°</span><span></span></div>${rows || '<p class="empty-inline">No fixed items.</p>'}<button id="add-fixed-inline" class="button ghost full">+ Add fixed placement</button>`;
}

function numberField(label: string, scope: string, field: string, value: number, step: number): string {
  return `<label title="${escapeHtml(optionHelp(field))}">${label}<input type="number" value="${value}" step="${step}" data-pack-scope="${scope}" data-field="${field}"></label>`;
}

function optionHelp(field: string): string {
  const help: Record<string, string> = {
    item_to_item: "Minimum edge-to-edge gap between packed items.", item_to_boundary: "Minimum distance from each item to the container boundary.", item_to_exclusion: "Minimum distance from items to keep-out regions.", seed: "Reuses the same random sequence for repeatable layouts.", max_iterations: "Search effort per restart; higher values can improve layouts but take longer.", grid_step: "Translation sampling interval; smaller values are more precise and slower.", restarts: "Independent searches; more restarts improve robustness at added runtime.",
  };
  return help[field] ?? `Controls ${humanize(field).toLowerCase()} for this packing problem.`;
}

function selectionKindLabel(state: EditorState, value: CadSelection): string {
  return value.kind === "container" ? (state.containerParts[value.index]?.operation === "subtract" ? "Container cut-out" : "Container material")
    : value.kind === "exclusion" ? "Exclusion" : value.kind === "item" ? "Item to pack"
      : value.kind === "guide" ? "Drafting guide" : value.kind === "drafting" ? "Drafting shape"
        : value.kind === "dimension" || value.kind === "auto-dimension" ? "Dimension"
          : value.kind === "text" ? "Scene text" : value.kind === "trace" ? "Background image" : "Packed item";
}
