import { toolbarActionPaletteHtml, toolbarSplitPaletteHtml } from "./toolbar-palette";
import type { PrimitiveEditor } from "./types";

interface StudioShellOptions {
  studyDisplay: { dimensions: boolean; clearance: boolean };
  quickShapes: Record<"material" | "cutout" | "item" | "exclusion", PrimitiveEditor["kind"]>;
  quickDrafting: string;
}

export function studioShellHtml(options: StudioShellOptions): string {
  return `${packingPage(options.quickShapes, options.quickDrafting)}${sensitivityPage(options.studyDisplay)}${studioDialogs()}`;
}

function packingPage(quickShapes: StudioShellOptions["quickShapes"], quickDrafting: string): string {
  return `<section id="packing-page" class="app-page">
    <div id="cad-shell" class="cad-shell">
      <aside id="problem-panel" class="problem-panel">
        <header class="studio-brand"><div class="brand-lockup"><div><strong>OpenLayout</strong><small>2D packing studio</small></div></div><div class="project-quick"><select id="quick-project" aria-label="Switch project"></select><button id="open-projects" class="project-chip" aria-label="Edit projects" title="Manage, import, and export projects"><span id="active-project-name" class="sr-only"></span>•••</button></div></header>
        <div id="packing-sidebar" class="problem-panel-scroll"></div>
        <footer class="run-dock"><div class="run-buttons"><button id="validate" class="sr-only" tabindex="-1" title="Validation runs automatically">Validate</button><button id="cancel" class="button danger" hidden disabled>Stop</button><button id="solve" class="button primary" title="Run packing (R)">Run packing</button><button id="result-export" class="button ghost result-action" hidden>Export</button><button id="return-to-edit" class="button ghost result-action" hidden>Return to edit</button></div><div id="solve-progress-wrap" class="solve-progress-wrap" hidden><div><strong id="solve-stage">Preparing…</strong><span id="solve-detail"></span></div><progress id="solve-progress" max="100" value="0" aria-label="Packing solve progress"></progress></div></footer>
      </aside>
      <main class="cad-stage-shell">
        ${workspaceToolbar(quickShapes, quickDrafting)}
        <input id="toolbar-trace-image-input" class="sr-only" type="file" accept="image/*" data-trace-image aria-label="Choose trace image">
        <section id="drafting-panel" class="cad-tool-panel" aria-label="Drafting aids panel" hidden></section>
        <section id="view-settings-panel" class="cad-tool-panel view-settings-panel" aria-label="View settings panel" hidden></section>
        <svg id="cad-canvas" class="cad-canvas" tabindex="0" aria-label="Interactive packing workspace"></svg>
        <div class="cad-nav-toolbar" aria-label="View navigation"><button id="fit-view" class="tool-button icon-tool" aria-label="Fit workspace" title="Fit workspace (F)">⌗</button><button id="focus-selection" class="tool-button icon-tool" aria-label="Focus selection" title="Zoom to selected geometry (Shift+F)">◎</button><button id="zoom-in" class="tool-button icon-tool" aria-label="Zoom in" title="Zoom in (+)">＋</button><button id="zoom-out" class="tool-button icon-tool" aria-label="Zoom out" title="Zoom out (−)">−</button><button id="select-tool" class="tool-button icon-tool active" aria-label="Select tool" aria-pressed="true" title="Select tool">↖</button></div>
        <div class="cad-help">Ctrl/⌘ drag: marquee · Alt: bypass snap · Shift: opposite-edge resize</div>
        <div class="workspace-state"><span id="status-dot"></span><span id="status" class="status neutral">Saved locally</span><strong id="workspace-summary">Problem definition</strong></div>
        <div id="cad-context-menu" class="cad-context-menu" hidden><button data-context-action="focus">Focus selection</button><button data-context-action="copy">Copy</button><button data-context-action="duplicate">Duplicate</button><button data-context-action="lock">Lock</button><button data-context-action="front">Bring to front</button><button data-context-action="back">Send to back</button><button data-context-action="reset-rotation">Reset rotation</button><button data-context-action="fixed">Toggle fixed</button><button data-context-action="delete" class="danger-text">Delete</button></div>
      </main>
    </div>
  </section>`;
}

const QUICK_SHAPES = [
  { value: "rectangle", icon: "▭", label: "Rectangle", detail: "Width and height" },
  { value: "circle", icon: "○", label: "Circle", detail: "Radius" },
  { value: "triangle", icon: "△", label: "Triangle", detail: "Base and height" },
  { value: "polygon", icon: "⬠", label: "Polygon", detail: "Editable vertices" },
  { value: "bezier", icon: "∿", label: "Bézier", detail: "Editable curve" },
] satisfies Array<{ value: PrimitiveEditor["kind"]; icon: string; label: string; detail: string }>;

const QUICK_DRAFTING = [
  { value: "vertical-guide", icon: "┃", label: "Vertical guide", detail: "Place a construction line" },
  { value: "horizontal-guide", icon: "━", label: "Horizontal guide", detail: "Place a construction line" },
  { value: "line", icon: "╱", label: "Two-point line", detail: "Click two endpoints" },
  { value: "polyline", icon: "⌁", label: "Polyline", detail: "Click points to draw a path" },
  { value: "rectangle", icon: "▭", label: "Rectangle", detail: "Drafting geometry" },
  { value: "circle", icon: "○", label: "Circle", detail: "Drafting geometry" },
  { value: "trace", icon: "▧", label: "Trace image", detail: "Place a reference image" },
  { value: "text", icon: "T", label: "Text", detail: "Add an annotation" },
  { value: "settings", icon: "⚙", label: "Drafting settings", detail: "Grid, snap, guides and traces" },
];

function workspaceToolbar(quickShapes: StudioShellOptions["quickShapes"], quickDrafting: string): string {
  return `<div class="cad-toolbar" aria-label="Workspace tools">
    <div class="toolbar-group" aria-label="Panel"><button id="sidebar-toggle" class="tool-button icon-tool" aria-label="Hide problem panel" title="Problem panel (P)">☰</button></div>
    <div class="toolbar-group" aria-label="Draw">${toolbarSplitPaletteHtml("add-material", "Material", QUICK_SHAPES, quickShapes.material)}${toolbarSplitPaletteHtml("add-cutout", "Cut-out", QUICK_SHAPES, quickShapes.cutout, "▱")}${toolbarSplitPaletteHtml("add-item", "Item", QUICK_SHAPES, quickShapes.item)}${toolbarSplitPaletteHtml("add-exclusion", "Exclusion", QUICK_SHAPES, quickShapes.exclusion, "⊘")}</div>
    <div class="toolbar-group" aria-label="Edit"><label class="toolbar-color" title="Selected colour"><input id="toolbar-part-color" type="color" aria-label="Selected colour" value="#51c6a4"></label><label class="toolbar-transparency" title="Selected fill transparency"><input id="toolbar-color-transparency" type="range" min="0" max="100" step="1" value="0" aria-label="Selected fill transparency" disabled></label><button id="delete-selection" class="tool-button danger-tool icon-tool" aria-label="Delete selection" title="Delete selection (Delete)">⌫</button></div>
    <div class="toolbar-group" aria-label="View">${toolbarSplitPaletteHtml("add-drafting", "Drafting", QUICK_DRAFTING, quickDrafting)}<button id="toggle-grid-snap" class="tool-button icon-tool active" aria-label="Disable grid snapping" aria-pressed="true">⌗</button><button id="respect-manual-constraints" class="tool-button icon-tool active" aria-label="Toggle manual collision guard" aria-pressed="true">♢</button>${toolbarActionPaletteHtml("toggle-dimensions", "Dimensions", "▤", [{ value: "create", icon: "↔", label: "Dimension between two points", detail: "Click a start and end point" }], "Dimensions · hover for actions (D)")}<button id="toggle-clearance" class="tool-button compact-overlay" aria-label="Spacing" aria-pressed="false" title="Spacing overlay (G)">◌</button><button id="open-view-settings" class="tool-button icon-tool" aria-label="View settings" aria-pressed="false" title="View settings">⚙</button></div>
    <span class="tool-spacer"></span>
    <div class="toolbar-group" aria-label="History"><button id="undo" class="tool-button" aria-label="Undo" title="Undo (Ctrl/⌘+Z)" disabled>↶</button><button id="redo" class="tool-button" aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)" disabled>↷</button></div>
    <div class="toolbar-group" aria-label="Output"><button id="theme-toggle" class="tool-button icon-tool" aria-label="Toggle theme" title="Toggle light/dark theme">◐</button><button id="open-export" class="tool-button labeled-tool" aria-label="Export" title="Export (E)"><span aria-hidden="true">⇩</span>Export</button><details class="toolbar-more"><summary class="tool-button labeled-tool" aria-label="More tools"><span aria-hidden="true">•••</span>More</summary><div class="more-menu">
      <button id="lock-selection" aria-label="Lock selection">⌑ <span>Lock selection</span></button><button id="join-material" aria-label="Unify selected material">⌁ <span>Unify material</span></button><button id="open-diagnostics" aria-label="Diagnostics">⚙ <span>Diagnostics</span></button><button id="open-sensitivity" aria-label="Sensitivity">∿ <span>Sensitivity</span></button><button id="open-shortcuts" aria-label="Keyboard shortcuts">⌨ <span>Keyboard shortcuts</span></button>
    </div></details></div>
    <div hidden><button id="draw-dimension"></button><button id="open-drafting-aids"></button><button id="add-vertical-guide"></button><button id="add-horizontal-guide"></button><button id="draw-drafting-line"></button><button id="draw-drafting-polyline"></button><button id="add-trace-image"></button><button id="add-scene-text"></button></div>
  </div>`;
}

function sensitivityPage(display: StudioShellOptions["studyDisplay"]): string {
  return `<section id="sensitivity-page" class="app-page" hidden>
    <div class="sensitivity-header"><button id="back-to-workspace" class="button ghost" title="Open workspace (1)">← Workspace</button><div><small>SENSITIVITY</small><strong>Capacity study</strong></div><span class="sensitivity-header-spacer"></span><button id="edit-study-source" class="button ghost">Edit varied geometry</button><button id="open-export-study" class="button ghost" title="Export (E)">Export</button><button id="open-shortcuts-study" class="tool-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">⌨</button><button id="theme-toggle-study" class="tool-button" aria-label="Toggle theme from sensitivity">◐</button></div>
    <div class="page-shell sensitivity-shell"><aside id="sensitivity-sidebar" class="side-panel"></aside><main class="sensitivity-content">
      <section class="panel study-preview-panel"><div class="panel-heading"><div><small>GEOMETRY PREVIEW</small><h1>Study steps and extremes</h1></div>${overlayToggles("study", display)}</div><div id="study-shape-preview" class="sensitivity-steps"></div></section>
      <section class="study-results-grid"><div class="panel sensitivity-panel"><div class="panel-heading"><div><small>PARAMETER STUDY</small><h2>Capacity transitions</h2></div><div id="study-progress" class="study-progress" hidden><progress max="100" value="0"></progress><span>Preparing…</span></div></div><div id="sensitivity-scroll" class="sensitivity-scroll"><canvas id="sensitivity-canvas" tabindex="0" aria-label="Sensitivity capacity chart"></canvas></div><div id="transitions" class="transition-list"></div></div><div class="panel sensitivity-layout-panel"><div class="panel-heading"><div><small>SELECTED RESULT</small><h2 id="sensitivity-layout-title">No result selected</h2></div><div class="selected-layout-actions"><button id="edit-selected-layout" class="button ghost" disabled>Edit layout</button><div id="sensitivity-layout-id" class="layout-id">—</div></div></div><canvas id="sensitivity-layout-canvas" aria-label="Selected sensitivity layout"></canvas><div id="sensitivity-metrics" class="metrics"></div></div></section>
    </main></div>
  </section>`;
}

function studioDialogs(): string {
  return `<dialog id="project-dialog" class="studio-dialog"><form method="dialog"><header><div><small>LOCAL WORKSPACE</small><h2>Projects</h2></div><button class="dialog-close" value="cancel" aria-label="Close projects">×</button></header><div id="project-dialog-body"></div></form></dialog>
  <dialog id="diagnostics-dialog" class="studio-dialog diagnostics-dialog"><form method="dialog"><header><div><small>ENGINE OUTPUT</small><h2>Diagnostics & metrics</h2></div><button class="dialog-close" value="cancel" aria-label="Close diagnostics">×</button></header><div id="diagnostics" class="diagnostics"><p>Run a solve to inspect validation and search statistics.</p></div><footer><button id="copy-result" type="button" class="button ghost">Copy result JSON</button><button class="button" value="cancel">Done</button></footer></form></dialog>
  <dialog id="export-dialog" class="studio-dialog export-dialog"><form method="dialog"><header><div><small>DOWNLOADS</small><h2>Export workspace</h2></div><button class="dialog-close" value="cancel" aria-label="Close export options">×</button></header><div id="export-options" class="export-options"></div></form></dialog>
  <dialog id="shortcuts-dialog" class="studio-dialog shortcuts-dialog"><form method="dialog"><header><div><small>QUICK REFERENCE</small><h2>Keyboard shortcuts</h2></div><button class="dialog-close" value="cancel" aria-label="Close keyboard shortcuts">×</button></header><div id="shortcut-list" class="shortcut-list"></div></form></dialog>`;
}

function overlayToggles(prefix: string, display: { dimensions: boolean; clearance: boolean }): string {
  return `<div class="layout-tools"><label><input id="${prefix}-dimensions" type="checkbox" ${display.dimensions ? "checked" : ""}> Dimensions</label><label><input id="${prefix}-clearance" type="checkbox" ${display.clearance ? "checked" : ""}> Clearance</label></div>`;
}
