import type { PackingProblem, SensitivityProgress, SensitivityResult, SensitivityStudy, SolveOptions, SolveProgress, SolveResult } from "./types";
import type { SolveLane, WorkerRequest, WorkerRequestPayload, WorkerResponse } from "./worker-protocol";

interface Pending {
  workerIndex: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress?: (progress: SolveProgress | SensitivityProgress) => void;
}

export class SolverClient {
  private workers: Worker[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyPromises: Promise<void>[] = [];
  private readyResolves: Array<() => void> = [];
  private readyRejects: Array<(error: Error) => void> = [];

  constructor() { this.start(); }

  validate(problem: PackingProblem): Promise<void> {
    return this.requestOn(0, { type: "validate", problem });
  }

  async solve(problem: PackingProblem, options: SolveOptions, progress: (value: SolveProgress) => void): Promise<SolveResult> {
    if (!this.canRunClearancePortfolio(problem, options) || this.workers.length < 2) {
      return this.requestOn(0, { type: "solve", problem, options }, (value) => progress(value as SolveProgress));
    }
    const started = performance.now();
    let bestProgress: SolveProgress | null = null;
    const report = (value: SolveProgress | SensitivityProgress) => {
      const next = value as SolveProgress;
      if (bestProgress === null
        || next.packed_item_count > bestProgress.packed_item_count
        || (next.packed_item_count === bestProgress.packed_item_count && next.completed_fraction > bestProgress.completed_fraction)) {
        bestProgress = next;
        progress(next);
      }
    };
    const jobs = this.workers.map((_, workerIndex) => {
      const lane: SolveLane = workerIndex === 1 ? "clearance_continuation" : "direct";
      const workerOptions = workerIndex === 1 ? options : {
        ...options,
        seed: workerIndex === 0 ? options.seed : this.derivedSeed(options.seed, workerIndex),
        max_iterations: Math.max(10_000, Math.floor(options.max_iterations / (workerIndex === 0 ? 2 : 4))),
        restarts: Math.min(options.restarts, workerIndex === 0 ? 2 : 1),
      };
      return this.requestOn<SolveResult>(workerIndex, { type: "solve", problem, options: workerOptions, lane }, report);
    });
    const settled = await Promise.allSettled(jobs);
    const results = settled
      .filter((entry): entry is PromiseFulfilledResult<SolveResult> => entry.status === "fulfilled")
      .map((entry) => entry.value);
    if (results.length === 0) {
      const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      throw failure?.reason ?? new Error("All solver workers failed");
    }
    results.sort((a, b) => this.compareResults(a, b));
    const best = results[0];
    best.runtime_timing = {
      total_ms: performance.now() - started,
      phase_ms: best.runtime_timing?.phase_ms ?? {},
      worker_count: this.workers.length,
    };
    return best;
  }

  sensitivity(problem: PackingProblem, study: SensitivityStudy, progress: (value: SensitivityProgress) => void): Promise<SensitivityResult> {
    return this.requestOn(0, { type: "sensitivity", problem, study }, (value) => progress(value as SensitivityProgress));
  }

  cancel(): void {
    for (const reject of this.readyRejects) reject(new Error("Run cancelled"));
    for (const worker of this.workers) worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Run cancelled"));
    this.pending.clear();
    this.start();
  }

  private start(): void {
    this.workers = [];
    this.readyPromises = [];
    this.readyResolves = [];
    this.readyRejects = [];
    const available = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
    const workerCount = Math.max(2, Math.min(4, Math.floor(available / 2)));
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      this.readyPromises.push(new Promise((resolve, reject) => {
        this.readyResolves.push(resolve);
        this.readyRejects.push(reject);
      }));
      const worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => this.onMessage(workerIndex, data);
      worker.onerror = (event) => this.onWorkerError(workerIndex, event.message);
      this.workers.push(worker);
    }
  }

  private async requestOn<T>(workerIndex: number, request: WorkerRequestPayload, progress?: (value: SolveProgress | SensitivityProgress) => void): Promise<T> {
    await this.readyPromises[workerIndex];
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { workerIndex, resolve: resolve as (value: unknown) => void, reject, progress });
      this.workers[workerIndex].postMessage({ ...request, id } as WorkerRequest);
    });
  }

  private onMessage(workerIndex: number, message: WorkerResponse): void {
    if (message.type === "ready") { this.readyResolves[workerIndex](); return; }
    const pending = this.pending.get(message.id);
    if (!pending || pending.workerIndex !== workerIndex) return;
    if (message.type === "progress" || message.type === "sensitivity-progress") { pending.progress?.(message.progress); return; }
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else if (message.type === "validated") pending.resolve(undefined);
    else pending.resolve(message.result);
  }

  private onWorkerError(workerIndex: number, message: string): void {
    const error = new Error(message);
    this.readyRejects[workerIndex](error);
    for (const [id, pending] of this.pending) {
      if (pending.workerIndex === workerIndex) {
        pending.reject(error);
        this.pending.delete(id);
      }
    }
  }

  private canRunClearancePortfolio(problem: PackingProblem, options: SolveOptions): boolean {
    return options.quality !== "fast"
      && options.max_iterations >= 40_000
      && problem.items.length === 1
      && problem.clearance.item_to_item > 0;
  }

  private derivedSeed(seed: number, workerIndex: number): number {
    return (seed ^ Math.imul(workerIndex + 1, 0x9e3779b1)) >>> 0;
  }

  private compareResults(a: SolveResult, b: SolveResult): number {
    return b.packed_item_count - a.packed_item_count
      || Number(b.validation.valid) - Number(a.validation.valid)
      || b.objective_score - a.objective_score
      || a.layout_id.localeCompare(b.layout_id);
  }
}
