/// <reference lib="webworker" />
import init, { PackingEngine } from "./wasm/packing_wasm.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const scope = self as DedicatedWorkerGlobalScope;
const bootStarted = performance.now();
const wasm = await init();
const coldStartMs = performance.now() - bootStarted;
const engine = new PackingEngine();

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === "validate") {
      engine.validate(JSON.stringify(data.problem));
      post({ id: data.id, type: "validated" });
    } else if (data.type === "solve") {
      const started = performance.now();
      let phaseStarted = started;
      let activePhase: string | null = null;
      const phaseMs: Record<string, number> = {};
      let callbackCount = 0;
      let callbackBytes = 0;
      const reportProgress = (progressJson: string) => {
        callbackCount += 1;
        callbackBytes += progressJson.length;
        const progress = JSON.parse(progressJson);
        const now = performance.now();
        if (activePhase !== null && progress.phase !== activePhase) {
          phaseMs[activePhase] = (phaseMs[activePhase] ?? 0) + now - phaseStarted;
          phaseStarted = now;
        }
        activePhase = progress.phase;
        post({ id: data.id, type: "progress", progress });
      };
      const problem = data.problemJson;
      const options = data.optionsJson;
      const encoded = data.reportProgress === false
        ? data.lane === "direct"
          ? engine.solve_direct(problem, options)
          : data.lane === "clearance_continuation"
            ? engine.solve_clearance_continuation(problem, options)
            : engine.solve(problem, options)
        : data.lane === "direct"
          ? engine.solve_direct_with_progress(problem, options, reportProgress)
          : data.lane === "clearance_continuation"
            ? engine.solve_clearance_continuation_with_progress(problem, options, reportProgress)
            : engine.solve_with_progress(problem, options, reportProgress);
      const finished = performance.now();
      if (activePhase !== null) phaseMs[activePhase] = (phaseMs[activePhase] ?? 0) + finished - phaseStarted;
      const result = JSON.parse(encoded);
      result.runtime_timing = {
        total_ms: finished - started,
        phase_ms: phaseMs,
        worker_count: 1,
        lane: data.lane ?? "full",
        cold_start_ms: coldStartMs,
        callback_count: callbackCount,
        callback_bytes: callbackBytes,
        request_bytes: problem.length + options.length,
        wasm_memory_bytes: wasm.memory.buffer.byteLength,
      };
      post({ id: data.id, type: "solved", result });
    } else {
      const problem = JSON.stringify(data.problem);
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
