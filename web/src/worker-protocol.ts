import type { PackingProblem, SensitivityProgress, SensitivityResult, SensitivityStudy, SolveOptions, SolveProgress, SolveResult } from "./types";

export type WorkerRequest =
  | { id: number; type: "validate"; problem: PackingProblem }
  | { id: number; type: "solve"; problem: PackingProblem; options: SolveOptions }
  | { id: number; type: "sensitivity"; problem: PackingProblem; study: SensitivityStudy };

export type WorkerRequestPayload =
  | { type: "validate"; problem: PackingProblem }
  | { type: "solve"; problem: PackingProblem; options: SolveOptions }
  | { type: "sensitivity"; problem: PackingProblem; study: SensitivityStudy };

export type WorkerResponse =
  | { type: "ready" }
  | { id: number; type: "progress"; progress: SolveProgress }
  | { id: number; type: "sensitivity-progress"; progress: SensitivityProgress }
  | { id: number; type: "validated" }
  | { id: number; type: "solved"; result: SolveResult }
  | { id: number; type: "sensitivity"; result: SensitivityResult }
  | { id: number; type: "error"; message: string };
