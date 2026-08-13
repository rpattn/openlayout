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
const BACKUP_KEY = `${STORAGE_KEY}.backup`;
const DATABASE_NAME = "openlayout.workspace";
const DATABASE_STORE = "snapshots";
const DATABASE_KEY = "workspace.v1";

export class WorkspaceStore {
  private workspace: StoredWorkspace;
  private loadedFromBrowserStorage = false;
  private durableWrite: Promise<void> = Promise.resolve();

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

  /** Restore a workspace if localStorage was cleared/corrupted or trails the durable mirror. */
  async recoverDurable(): Promise<boolean> {
    if (!this.usesBrowserStorage()) return false;
    const durable = parseWorkspace(await readDurableWorkspace());
    if (durable && (!this.loadedFromBrowserStorage || workspaceTimestamp(durable) > workspaceTimestamp(this.workspace))) {
      this.workspace = durable;
      this.loadedFromBrowserStorage = true;
      this.persistLocal(JSON.stringify(this.workspace));
      return true;
    }
    this.queueDurableWrite(JSON.stringify(this.workspace));
    return false;
  }

  /** Ask the browser not to evict this origin's durable data under storage pressure. */
  async requestPersistentStorage(): Promise<boolean> {
    try {
      return await navigator.storage?.persist?.() ?? false;
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> { await this.durableWrite; }

  private load(): StoredWorkspace {
    for (const key of [STORAGE_KEY, BACKUP_KEY]) {
      const parsed = parseWorkspace(this.storage.getItem(key));
      if (parsed) {
        this.loadedFromBrowserStorage = true;
        return parsed;
      }
    }
    const now = new Date().toISOString();
    const project: LocalProject = {
      id: crypto.randomUUID(), name: "Packing study 1", state: defaultState(), createdAt: now, updatedAt: now,
    };
    return { version: 1, activeProjectId: project.id, theme: "dark", projects: [project] };
  }

  private persist(): void {
    const serialized = JSON.stringify(this.workspace);
    this.persistLocal(serialized);
    this.queueDurableWrite(serialized);
  }

  private persistLocal(serialized: string): void {
    try {
      this.storage.setItem(STORAGE_KEY, serialized);
      this.storage.setItem(BACKUP_KEY, serialized);
      this.loadedFromBrowserStorage = true;
    } catch {
      // The IndexedDB mirror still has a chance to save if localStorage is full or unavailable.
    }
  }

  private queueDurableWrite(serialized: string): void {
    if (!this.usesBrowserStorage()) return;
    this.durableWrite = this.durableWrite
      .catch(() => undefined)
      .then(() => writeDurableWorkspace(serialized));
  }

  private usesBrowserStorage(): boolean {
    return typeof indexedDB !== "undefined" && typeof localStorage !== "undefined" && this.storage === localStorage;
  }

  private nextName(): string {
    let index = this.workspace.projects.length + 1;
    const names = new Set(this.workspace.projects.map((project) => project.name));
    while (names.has(`Packing study ${index}`)) index++;
    return `Packing study ${index}`;
  }
}

function parseWorkspace(raw: string | null): StoredWorkspace | null {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<StoredWorkspace> | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length === 0) return null;
    const projects = (parsed.projects as LocalProject[]).map(migrateProject);
    const activeProjectId = projects.some((project) => project.id === parsed.activeProjectId)
      ? parsed.activeProjectId! : projects[0].id;
    return { version: 1, activeProjectId, theme: parsed.theme === "light" ? "light" : "dark", projects };
  } catch {
    return null;
  }
}

function workspaceTimestamp(workspace: StoredWorkspace): number {
  return Math.max(0, ...workspace.projects.map((project) => Date.parse(project.updatedAt) || 0));
}

function openWorkspaceDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATABASE_STORE)) request.result.createObjectStore(DATABASE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readDurableWorkspace(): Promise<string | null> {
  const database = await openWorkspaceDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const transaction = database.transaction(DATABASE_STORE, "readonly");
    const request = transaction.objectStore(DATABASE_STORE).get(DATABASE_KEY);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function writeDurableWorkspace(serialized: string): Promise<void> {
  const database = await openWorkspaceDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    transaction.objectStore(DATABASE_STORE).put(serialized, DATABASE_KEY);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); resolve(); };
  });
}

function migrateProject(project: LocalProject): LocalProject {
  const state = project.state as unknown as { containerParts?: unknown[]; items?: unknown[]; exclusions?: Array<{ primitive?: unknown; parts?: unknown[] }>; lockedEntities?: EditorState["lockedEntities"]; viewSettings?: EditorState["viewSettings"]; dimensions?: EditorState["dimensions"]; dimensionPositions?: EditorState["dimensionPositions"]; dimensionOverrides?: EditorState["dimensionOverrides"]; drafting?: EditorState["drafting"] & { traceImage?: EditorState["drafting"]["traceImages"][number]; guides?: Array<Partial<EditorState["drafting"]["guides"][number]> & { axis?: "x" | "y"; position?: number }> } };
  state.containerParts ??= [];
  state.items ??= [];
  state.exclusions ??= [];
  state.exclusions.forEach((entry) => {
    if (!Array.isArray(entry.parts)) entry.parts = entry.primitive ? [entry.primitive] : [];
    delete entry.primitive;
  });
  state.drafting ??= { gridStep: 0.5, snapToGrid: true, smartSnap: true, defaultOwner: "material", guides: [], traceImages: [], texts: [], shapes: [] };
  state.drafting.defaultOwner ??= "material";
  state.drafting.guides ??= [];
  const legacyGuides = state.drafting.guides as unknown as Array<{ id?: string; x?: number; y?: number; rotation?: number; axis?: "x" | "y"; position?: number }>;
  state.drafting.guides = legacyGuides.map((guide) => ({
    id: guide.id ?? crypto.randomUUID(), x: guide.x ?? (guide.axis === "x" ? guide.position ?? 0 : 0),
    y: guide.y ?? (guide.axis === "y" ? guide.position ?? 0 : 0), rotation: guide.rotation ?? (guide.axis === "x" ? 90 : 0),
  }));
  state.drafting.traceImages ??= state.drafting.traceImage ? [{ ...state.drafting.traceImage, rotation: state.drafting.traceImage.rotation ?? 0 }] : [];
  state.drafting.traceImages.forEach((trace) => { trace.id ??= crypto.randomUUID(); trace.rotation ??= 0; });
  state.drafting.texts ??= [];
  state.drafting.texts.forEach((entry) => {
    entry.fontFamily ??= "mono"; entry.align ??= "left"; entry.bold ??= false; entry.italic ??= false; entry.underline ??= false;
  });
  state.drafting.shapes ??= [];
  delete state.drafting.traceImage;
  state.lockedEntities ??= [];
  state.viewSettings ??= { showGrid: true, showDimensions: false, showClearance: false, dimensionTextSize: 11, edgeThickness: 1.4, dimensionPrecision: 2, dimensionUnit: "mm" };
  state.viewSettings.showDimensions ??= false;
  state.viewSettings.showClearance ??= false;
  state.dimensions ??= [];
  state.dimensionPositions ??= {};
  state.dimensionOverrides ??= {};
  return project as LocalProject;
}

export class WorkspaceHistory<T = EditorState> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  constructor(private readonly limit = 80) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  commit(previous: T, current: T): void {
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    this.undoStack.push(structuredClone(previous));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: T): T | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(structuredClone(current));
    return structuredClone(previous);
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(structuredClone(current));
    return structuredClone(next);
  }

  clear(): void { this.undoStack = []; this.redoStack = []; }
}
