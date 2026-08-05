/// <reference lib="webworker" />
import init, { PackingEngine } from "./wasm/packing_wasm.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const scope = self as DedicatedWorkerGlobalScope;
await init();
const engine = new PackingEngine();

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const problem = JSON.stringify(data.problem);
    if (data.type === "validate") {
      engine.validate(problem);
      post({ id: data.id, type: "validated" });
    } else if (data.type === "solve") {
      const started = performance.now();
      let phaseStarted = started;
      let activePhase: string | null = null;
      const phaseMs: Record<string, number> = {};
      const reportProgress = (progressJson: string) => {
        const progress = JSON.parse(progressJson);
        const now = performance.now();
        if (activePhase !== null && progress.phase !== activePhase) {
          phaseMs[activePhase] = (phaseMs[activePhase] ?? 0) + now - phaseStarted;
          phaseStarted = now;
        }
        activePhase = progress.phase;
        post({ id: data.id, type: "progress", progress });
      };
      const encoded = data.lane === "direct"
        ? engine.solve_direct_with_progress(problem, JSON.stringify(data.options), reportProgress)
        : data.lane === "clearance_continuation"
          ? engine.solve_clearance_continuation_with_progress(problem, JSON.stringify(data.options), reportProgress)
          : engine.solve_with_progress(problem, JSON.stringify(data.options), reportProgress);
      const finished = performance.now();
      if (activePhase !== null) phaseMs[activePhase] = (phaseMs[activePhase] ?? 0) + finished - phaseStarted;
      const result = JSON.parse(encoded);
      result.runtime_timing = { total_ms: finished - started, phase_ms: phaseMs, worker_count: 1 };
      post({ id: data.id, type: "solved", result });
    } else {
      const encoded = engine.sensitivity_with_progress(problem, JSON.stringify(data.study), (progressJson: string) => {
        post({ id: data.id, type: "sensitivity-progress", progress: JSON.parse(progressJson) });
      });
      post({ id: data.id, type: "sensitivity", result: JSON.parse(encoded) });
    }
  } catch (error) {
    post({ id: data.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

post({ type: "ready" });

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}
