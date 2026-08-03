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
      const encoded = engine.solve_with_progress(problem, JSON.stringify(data.options), (progressJson: string) => {
        post({ id: data.id, type: "progress", progress: JSON.parse(progressJson) });
      });
      post({ id: data.id, type: "solved", result: JSON.parse(encoded) });
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
