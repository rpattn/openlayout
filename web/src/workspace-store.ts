import { defaultState, emptyState } from "./problem";
import type { EditorState } from "./types";

export type ThemePreference = "light" | "dark";

export interface LocalProject {
  id: string;
  name: string;
  state: EditorState;
  createdAt: string;
  updatedAt: string;
}

interface StoredWorkspace {
  version: 1;
  activeProjectId: string;
  theme: ThemePreference;
  projects: LocalProject[];
}

const STORAGE_KEY = "openlayout.workspace.v1";

export class WorkspaceStore {
  private workspace: StoredWorkspace;

  constructor(private readonly storage: Storage = localStorage) {
    this.workspace = this.load();
  }

  get projects(): readonly LocalProject[] { return this.workspace.projects; }
  get activeProjectId(): string { return this.workspace.activeProjectId; }
  get theme(): ThemePreference { return this.workspace.theme; }
  get active(): LocalProject {
    return this.workspace.projects.find((project) => project.id === this.workspace.activeProjectId)
      ?? this.workspace.projects[0];
  }

  save(state: EditorState): void {
    const project = this.active;
    project.state = structuredClone(state);
    project.updatedAt = new Date().toISOString();
    this.persist();
  }

  create(name = this.nextName(), empty = false): LocalProject {
    const now = new Date().toISOString();
    const project: LocalProject = {
      id: crypto.randomUUID(), name, state: empty ? emptyState() : defaultState(), createdAt: now, updatedAt: now,
    };
    this.workspace.projects.push(project);
    this.workspace.activeProjectId = project.id;
    this.persist();
    return project;
  }

  switch(id: string): LocalProject {
    const project = this.workspace.projects.find((entry) => entry.id === id);
    if (!project) throw new Error("Local project no longer exists");
    this.workspace.activeProjectId = id;
    this.persist();
    return project;
  }

  rename(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name cannot be empty");
    this.active.name = trimmed;
    this.active.updatedAt = new Date().toISOString();
    this.persist();
  }

  duplicate(): LocalProject {
    const source = this.active;
    const now = new Date().toISOString();
    const project: LocalProject = {
      id: crypto.randomUUID(), name: `${source.name} copy`, state: structuredClone(source.state), createdAt: now, updatedAt: now,
    };
    this.workspace.projects.push(project);
    this.workspace.activeProjectId = project.id;
    this.persist();
    return project;
  }

  deleteActive(): LocalProject {
    if (this.workspace.projects.length === 1) throw new Error("Keep at least one local project");
    const index = this.workspace.projects.findIndex((project) => project.id === this.activeProjectId);
    this.workspace.projects.splice(index, 1);
    const next = this.workspace.projects[Math.max(0, index - 1)];
    this.workspace.activeProjectId = next.id;
    this.persist();
    return next;
  }

  setTheme(theme: ThemePreference): void {
    this.workspace.theme = theme;
    this.persist();
  }

  private load(): StoredWorkspace {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredWorkspace> | null;
      if (parsed?.version === 1 && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
        const activeProjectId = parsed.projects.some((project) => project.id === parsed.activeProjectId)
          ? parsed.activeProjectId! : parsed.projects[0].id;
        return {
          version: 1,
          activeProjectId,
          theme: parsed.theme === "light" ? "light" : "dark",
          projects: (parsed.projects as LocalProject[]).map(migrateProject),
        };
      }
    } catch {
      // A malformed local record should not prevent the studio from opening.
    }
    const now = new Date().toISOString();
    const project: LocalProject = {
      id: crypto.randomUUID(), name: "Packing study 1", state: defaultState(), createdAt: now, updatedAt: now,
    };
    return { version: 1, activeProjectId: project.id, theme: "dark", projects: [project] };
  }

  private persist(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.workspace));
  }

  private nextName(): string {
    let index = this.workspace.projects.length + 1;
    const names = new Set(this.workspace.projects.map((project) => project.name));
    while (names.has(`Packing study ${index}`)) index++;
    return `Packing study ${index}`;
  }
}

function migrateProject(project: LocalProject): LocalProject {
  const state = project.state as unknown as { containerParts?: unknown[]; items?: unknown[]; exclusions?: Array<{ primitive?: unknown; parts?: unknown[] }> };
  state.containerParts ??= [];
  state.items ??= [];
  state.exclusions ??= [];
  state.exclusions.forEach((entry) => {
    if (!Array.isArray(entry.parts)) entry.parts = entry.primitive ? [entry.primitive] : [];
    delete entry.primitive;
  });
  return project as LocalProject;
}

export class WorkspaceHistory {
  private undoStack: EditorState[] = [];
  private redoStack: EditorState[] = [];
  constructor(private readonly limit = 80) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  commit(previous: EditorState, current: EditorState): void {
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    this.undoStack.push(structuredClone(previous));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: EditorState): EditorState | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(structuredClone(current));
    return structuredClone(previous);
  }

  redo(current: EditorState): EditorState | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(structuredClone(current));
    return structuredClone(next);
  }

  clear(): void { this.undoStack = []; this.redoStack = []; }
}
