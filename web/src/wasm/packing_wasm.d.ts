/* tslint:disable */
/* eslint-disable */

export class PackingEngine {
    free(): void;
    [Symbol.dispose](): void;
    feasible(input_json: string, options_json: string, target_count: number): string;
    constructor();
    sensitivity(input_json: string, study_json: string): string;
    sensitivity_with_progress(input_json: string, study_json: string, callback: Function): string;
    solve(input_json: string, options_json: string): string;
    solve_clearance_continuation_with_progress(input_json: string, options_json: string, callback: Function): string;
    solve_direct_with_progress(input_json: string, options_json: string, callback: Function): string;
    solve_with_progress(input_json: string, options_json: string, callback: Function): string;
    validate(input_json: string): string;
}

export function resolved_geometry(input_json: string): string;

export function run_sensitivity(input_json: string, study_json: string): string;

export function solve_problem(input_json: string, options_json: string): string;

export function validate_problem(input_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_packingengine_free: (a: number, b: number) => void;
    readonly packingengine_feasible: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly packingengine_new: () => number;
    readonly packingengine_sensitivity: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly packingengine_sensitivity_with_progress: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number, number];
    readonly packingengine_solve: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly packingengine_solve_clearance_continuation_with_progress: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number, number];
    readonly packingengine_solve_direct_with_progress: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number, number];
    readonly packingengine_solve_with_progress: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number, number];
    readonly packingengine_validate: (a: number, b: number, c: number) => [number, number, number, number];
    readonly resolved_geometry: (a: number, b: number) => [number, number, number, number];
    readonly run_sensitivity: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly solve_problem: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly validate_problem: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
