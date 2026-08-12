import type { PackingProblem } from "./types";
import type { LocalProject } from "./workspace-store";
import { escapeHtml } from "./ui-utils";

export function projectDialogHtml(projects: readonly LocalProject[], activeProjectId: string, problem: PackingProblem): string {
  const active = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const options = projects.map((project) => `<option value="${project.id}" ${project.id === activeProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  return `<div class="project-dialog-grid"><label>Active project<select id="project-select" aria-label="Local project">${options}</select></label><label>Project name<input id="project-name" aria-label="Project name" value="${escapeHtml(active?.name ?? "")}"></label></div>
    <p class="dialog-note">Projects are autosaved to two browser stores for restart recovery. Use Problem JSON below for a portable geometry backup.</p>
    <div class="dialog-actions"><button id="new-project" type="button" class="button ghost">New project</button><button id="empty-project" type="button" class="button ghost">New empty</button><button id="duplicate-project" type="button" class="button ghost">Duplicate</button><button id="delete-project" type="button" class="button danger">Delete</button><span></span><button id="save-project" type="button" class="button primary">Save changes</button></div>
    <details class="json-panel"><summary>Problem JSON <span>Import / export</span></summary><div class="details-body"><textarea id="problem-json" rows="11">${escapeHtml(JSON.stringify(problem, null, 2))}</textarea><div class="inline-actions"><button id="load-json" type="button" class="button ghost">Load JSON</button><button id="copy-problem" type="button" class="button ghost">Copy JSON</button></div></div></details>`;
}

export interface ExportAvailability {
  layout: boolean;
  sensitivity: boolean;
}

export function exportOptionsHtml({ layout, sensitivity }: ExportAvailability): string {
  return `<p class="export-intro">Choose a ready-to-use format. Vector exports preserve geometry; CSV is convenient for fabrication and downstream tools.</p><div class="export-grid">
    ${exportCard("Problem JSON", "Complete editable geometry and constraints", "problem-json")}
    ${exportCard("Shape library SVG", "All packable definitions as clean vectors", "shapes-svg")}
    ${exportCard("Layout SVG", "Solved placements, container, and exclusions", "layout-svg", !layout)}
    ${exportCard("Layout PNG", "High-resolution image with active overlays", "layout-png", !layout)}
    ${exportCard("Scene PNG", "Everything in the fitted workspace scene", "scene-png")}
    ${exportCard("Placements CSV", "Item, position, rotation, and fixed state", "placements-csv", !layout)}
    ${exportCard("Solve JSON", "Full result, metrics, and validation", "solve-json", !layout)}
    ${exportCard("Sensitivity JSON", "Evaluations, transitions, and representative layouts", "study-json", !sensitivity)}
  </div>`;
}

function exportCard(title: string, description: string, kind: string, disabled = false): string {
  return `<article><div><strong>${title}</strong><p>${description}</p></div><button type="button" class="button ghost" data-export="${kind}" ${disabled ? "disabled" : ""}>Download</button></article>`;
}
