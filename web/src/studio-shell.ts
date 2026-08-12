import { toolbarPaletteHtml } from "./toolbar-palette";
import type { EditorState } from "./types";

interface StudioShellOptions {
  defaultOwner: EditorState["drafting"]["defaultOwner"];
  studyDisplay: { dimensions: boolean; clearance: boolean };
}

export function studioShellHtml(options: StudioShellOptions): string {
  return `${packingPage(options.defaultOwner)}${sensitivityPage(options.studyDisplay)}${studioDialogs()}`;
}

function packingPage(defaultOwner: StudioShellOptions["defaultOwner"]): string {
  return `<section id="packing-page" class="app-page">
    <div id="cad-shell" class="cad-shell">
      <aside id="problem-panel" class="problem-panel">
        <header class="studio-brand"><div class="brand-lockup"><div><strong>OpenLayout</strong><small>2D packing studio</small></div></div><div class="project-quick"><select id="quick-project" aria-label="Switch project"></select><button id="open-projects" class="project-chip" aria-label="Edit projects" title="Manage, import, and export projects"><span id="active-project-name" class="sr-only"></span>•••</button></div></header>
        <div id="packing-sidebar" class="problem-panel-scroll"></div>
        <footer class="run-dock"><div class="run-buttons"><button id="validate" class="button ghost" title="Validate problem (V)">Validate</button><button id="cancel" class="button danger" disabled>Stop</button><button id="solve" class="button primary" title="Run packing (R)">Run packing</button></div><div id="solve-progress-wrap" class="solve-progress-wrap" hidden><div><strong id="solve-stage">Preparing…</strong><span id="solve-detail"></span></div><progress id="solve-progress" max="100" value="0" aria-label="Packing solve progress"></progress></div></footer>
      </aside>
      <main class="cad-stage-shell">
        ${workspaceToolbar(defaultOwner)}
        <input id="toolbar-trace-image-input" class="sr-only" type="file" accept="image/*" data-trace-image aria-label="Choose trace image">
        <section id="drafting-panel" class="cad-tool-panel" aria-label="Drafting aids panel" hidden></section>
        <section id="view-settings-panel" class="cad-tool-panel view-settings-panel" aria-label="View settings panel" hidden></section>
        <svg id="cad-canvas" class="cad-canvas" tabindex="0" aria-label="Interactive packing workspace"></svg>
        <div class="cad-nav-toolbar" aria-label="View navigation"><button id="select-tool" class="tool-button active icon-tool" aria-label="Select tool" title="Select tool">↖</button><button id="fit-view" class="tool-button icon-tool" aria-label="Fit workspace" title="Fit workspace (F)">⌗</button><button id="focus-selection" class="tool-button icon-tool" aria-label="Focus selection" title="Zoom to selected geometry (Shift+F)">◎</button><button id="zoom-in" class="tool-button icon-tool" aria-label="Zoom in" title="Zoom in (+)">＋</button><button id="zoom-out" class="tool-button icon-tool" aria-label="Zoom out" title="Zoom out (−)">−</button></div>
        <div class="cad-help">Ctrl/⌘ drag: marquee · Alt: bypass snap · Shift: opposite-edge resize</div>
        <div class="workspace-state"><span id="status-dot"></span><span id="status" class="status neutral">Saved locally</span><strong id="workspace-summary">Problem definition</strong></div>
        <div id="cad-context-menu" class="cad-context-menu" hidden><button data-context-action="focus">Focus selection</button><button data-context-action="copy">Copy</button><button data-context-action="duplicate">Duplicate</button><button data-context-action="lock">Lock</button><button data-context-action="front">Bring to front</button><button data-context-action="back">Send to back</button><button data-context-action="reset-rotation">Reset rotation</button><button data-context-action="fixed">Toggle fixed</button><button data-context-action="delete" class="danger-text">Delete</button></div>
      </main>
    </div>
  </section>`;
}

function workspaceToolbar(defaultOwner: StudioShellOptions["defaultOwner"]): string {
  return `<div class="cad-toolbar" aria-label="Workspace tools">
    <div class="toolbar-group" aria-label="Panels"><button id="sidebar-toggle" class="tool-button" aria-label="Hide problem panel" title="Problem panel (P)">☰</button></div>
    <div class="toolbar-group" aria-label="Geometry"><button class="tool-button geometry-action icon-tool" data-toolbar-shape="rectangle" aria-label="Add rectangle" title="Rectangle">▭</button><button class="tool-button geometry-action icon-tool" data-toolbar-shape="circle" aria-label="Add circle" title="Circle">○</button>${toolbarPaletteHtml("toolbar-add-shape", "Add other geometry", "⬡", [
      { value: "triangle", icon: "△", label: "Triangle", detail: "3 vertices" },
      { value: "polygon", icon: "⬠", label: "Polygon", detail: "Vertex geometry" },
      { value: "bezier", icon: "∿", label: "Bézier", detail: "Curve geometry" },
    ])}${toolbarPaletteHtml("toolbar-default-owner", "Default new shape role", "◈", [
      { value: "material", icon: "▧", label: "Material", detail: "Container add" },
      { value: "cutout", icon: "▱", label: "Cut-out", detail: "Container subtract" },
      { value: "item", icon: "◇", label: "Item", detail: "Packable" },
      { value: "exclusion", icon: "⊘", label: "Exclusion", detail: "Keep-out" },
    ], defaultOwner)}</div>
    <div class="toolbar-group" aria-label="Selection"><label class="toolbar-color" title="Selected part colour"><input id="toolbar-part-color" type="color" aria-label="Selected part colour" value="#51c6a4"></label><button id="join-material" class="tool-button icon-tool" aria-label="Unify selected material" title="Unify material">⌁</button><button id="lock-selection" class="tool-button icon-tool" aria-label="Lock selection" title="Lock">⌑</button><button id="delete-selection" class="tool-button danger-tool" aria-label="Delete selection" title="Delete (Delete)">⌫</button><button id="respect-manual-constraints" class="tool-button compact-overlay active" aria-label="Toggle manual collision guard" aria-pressed="true" title="Collision guard">♢</button></div>
    <div class="toolbar-group" aria-label="Display"><button id="toggle-dimensions" class="tool-button compact-overlay" aria-label="Dimensions" aria-pressed="false" title="Dimensions (D)">↔</button><button id="toggle-clearance" class="tool-button compact-overlay" aria-label="Constraints" aria-pressed="false" title="Clearances (G)">◌</button><button id="open-view-settings" class="tool-button icon-tool" aria-label="View settings" aria-pressed="false" title="View settings">⚙</button></div>
    <div class="toolbar-group" aria-label="Drafting"><button id="toggle-grid-snap" class="tool-button snap-toggle" aria-label="Disable grid snapping" aria-pressed="true" title="Grid snapping on · hold Alt to bypass">⌗<span>Snap</span></button><button id="open-drafting-aids" class="tool-button icon-tool" aria-label="Drafting aids" aria-pressed="false" title="Drafting settings">⌗</button><button id="add-vertical-guide" class="tool-button icon-tool" aria-label="Add vertical drafting line" aria-pressed="false" title="Vertical guide">┃</button><button id="add-horizontal-guide" class="tool-button icon-tool" aria-label="Add horizontal drafting line" aria-pressed="false" title="Horizontal guide">━</button><button id="draw-drafting-line" class="tool-button icon-tool" aria-label="Draw two-point drafting line" aria-pressed="false" title="2-point line">╱</button><button id="draw-drafting-polyline" class="tool-button icon-tool" aria-label="Draw drafting polyline" aria-pressed="false" title="Polyline · Enter to finish">⌁</button><button id="draw-dimension" class="tool-button icon-tool" aria-label="Create dimension" aria-pressed="false" title="Dimension between two points">↔</button><button id="drafting-shape-mode" class="tool-button icon-tool" aria-label="Drafting shape mode" aria-pressed="false" title="Drafting geometry mode">◇</button><button id="add-trace-image" class="tool-button icon-tool" aria-label="Add trace image" title="Trace image">▧</button><button id="add-scene-text" class="tool-button icon-tool" aria-label="Add scene text" title="Text annotation">T</button></div>
    <span class="tool-spacer"></span>
    <div class="toolbar-group" aria-label="History"><button id="undo" class="tool-button" aria-label="Undo" title="Undo (Ctrl/⌘+Z)" disabled>↶</button><button id="redo" class="tool-button" aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)" disabled>↷</button></div>
    <div class="toolbar-group" aria-label="Analysis and output"><button id="open-diagnostics" class="tool-button icon-tool" aria-label="Diagnostics" title="Diagnostics">⚙</button><button id="open-sensitivity" class="tool-button icon-tool" aria-label="Sensitivity" title="Sensitivity analysis (2)">∿</button><button id="open-export" class="tool-button icon-tool" aria-label="Export" title="Export (E)">⇩</button><button id="open-shortcuts" class="tool-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">⌨</button><button id="theme-toggle" class="tool-button" aria-label="Toggle theme">◐</button></div>
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
