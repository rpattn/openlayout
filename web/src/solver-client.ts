import type { PackingProblem, SensitivityProgress, SensitivityResult, SensitivityStudy, SolveOptions, SolveProgress, SolveResult } from "./types";
import type { WorkerRequest, WorkerRequestPayload, WorkerResponse } from "./worker-protocol";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress?: (progress: SolveProgress | SensitivityProgress) => void;
}

export class SolverClient {
  private worker!: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyPromise!: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  constructor() { this.start(); }

  validate(problem: PackingProblem): Promise<void> {
    return this.request({ type: "validate", problem });
  }

  solve(problem: PackingProblem, options: SolveOptions, progress: (value: SolveProgress) => void): Promise<SolveResult> {
    return this.request({ type: "solve", problem, options }, (value) => progress(value as SolveProgress));
  }

  sensitivity(problem: PackingProblem, study: SensitivityStudy, progress: (value: SensitivityProgress) => void): Promise<SensitivityResult> {
    return this.request({ type: "sensitivity", problem, study }, (value) => progress(value as SensitivityProgress));
  }

  cancel(): void {
    this.readyReject(new Error("Run cancelled"));
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Run cancelled"));
    this.pending.clear();
    this.start();
  }

  private start(): void {
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => this.onMessage(data);
    this.worker.onerror = (event) => {
      this.readyReject(new Error(event.message));
      for (const pending of this.pending.values()) pending.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  private async request<T>(request: WorkerRequestPayload, progress?: (value: SolveProgress | SensitivityProgress) => void): Promise<T> {
    await this.readyPromise;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, progress });
      this.worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  private onMessage(message: WorkerResponse): void {
    if (message.type === "ready") { this.readyResolve(); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress" || message.type === "sensitivity-progress") { pending.progress?.(message.progress); return; }
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else if (message.type === "validated") pending.resolve(undefined);
    else pending.resolve(message.result);
  }
}
