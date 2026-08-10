import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PackingEngine, initSync, resolved_geometry } from "../src/wasm/packing_wasm.js";

const wasm = readFileSync(new URL("../src/wasm/packing_wasm_bg.wasm", import.meta.url));
initSync({ module: wasm });

const problem = {
  schema_version: 2,
  container: { parts: [{ id: "stock", operation: "add", shape: { kind: "rectangle", width: 12, height: 4 }, translation: { x: 0, y: 0 }, rotation_deg: 0 }] },
  exclusions: [],
  items: [{
    id: "item-a",
    quantity: 20,
    rotation_policy: { kind: "discrete", angles_deg: [0], coupling: "independent" },
    shape: {
      kind: "compound",
      parts: [{
        shape: { kind: "rectangle", width: 2, height: 4 },
        translation: { x: 0, y: 0 },
        rotation_deg: 0,
      }],
    },
  }],
  fixed_placements: [],
  clearance: { item_to_item: 0, item_to_boundary: 0, item_to_exclusion: 0 },
};

const options = {
  seed: 13,
  deterministic: true,
  max_iterations: 30_000,
  time_limit_ms: null,
  grid_step: 0.25,
  restarts: 2,
  quality: "balanced",
  baseline_only: false,
};

test("Wasm exposes the authoritative unified display contours", () => {
  const joined = structuredClone(problem);
  joined.container.parts.push({
    id: "joined", operation: "add", shape: { kind: "rectangle", width: 2, height: 4 },
    translation: { x: 99, y: 99 }, rotation_deg: 0,
    snap: { target_part: 0, own_anchor: "left", target_anchor: "right", offset: { x: -1, y: 0 } },
  });
  const geometry = JSON.parse(resolved_geometry(JSON.stringify(joined)));
  assert.equal(geometry.container.length, 1);
  assert.equal(geometry.items[0].polygons.length, 1);
  assert.deepEqual(geometry.exclusions, []);
});

test("Wasm engine validates, streams layouts, and reuses deterministic preparation", () => {
  const engine = new PackingEngine();
  assert.deepEqual(JSON.parse(engine.validate(JSON.stringify(problem))), { valid: true });
  const progress = [];
  const first = JSON.parse(engine.solve_direct_with_progress(
    JSON.stringify(problem),
    JSON.stringify(options),
    (json) => progress.push(JSON.parse(json)),
  ));
  const second = JSON.parse(engine.solve(JSON.stringify(problem), JSON.stringify(options)));

  assert.ok(progress.length >= 1);
  assert.ok(progress.some((entry) => entry.placements.length > 0));
  assert.ok(progress.some((entry) => entry.phase === "neighbourhood_improvement"));
  assert.ok(progress.every((entry) => entry.completed_fraction >= 0 && entry.completed_fraction <= 1));
  assert.equal(first.validation.valid, true);
  assert.equal(first.layout_id, second.layout_id);
  assert.deepEqual(first.placements, second.placements);
  engine.free();
});

test("Wasm baseline-only mode validates without refinement phases", () => {
  const engine = new PackingEngine();
  const progress = [];
  const result = JSON.parse(engine.solve_with_progress(
    JSON.stringify(problem),
    JSON.stringify({ ...options, baseline_only: true }),
    (json) => progress.push(JSON.parse(json)),
  ));
  assert.equal(result.packed_item_count, 6);
  assert.equal(result.validation.valid, true);
  assert.equal(result.statistics.explored_search_states, 0);
  assert.equal(result.statistics.local_improvement_attempts, 0);
  assert.deepEqual(new Set(progress.map((entry) => entry.phase)), new Set(["baseline", "validating"]));
  engine.free();
});

test("Wasm baseline learns clearance-aware complementary triangle rows", () => {
  const triangleProblem = {
    schema_version: 2,
    container: { parts: [{
      id: "stock", operation: "add",
      shape: { kind: "rectangle", width: 20, height: 15 },
      translation: { x: 0, y: 0 }, rotation_deg: 0,
    }] },
    exclusions: [],
    items: [{
      id: "item-a", quantity: 50,
      rotation_policy: { kind: "continuous", min_deg: 0, max_deg: 360, coupling: "independent" },
      shape: { kind: "compound", parts: [{
        shape: { kind: "triangle", base: 3, height: 3 },
        translation: { x: 0, y: 0 }, rotation_deg: 0, snap: null,
      }] },
    }],
    fixed_placements: [],
    clearance: { item_to_item: 0.35, item_to_boundary: 0.3, item_to_exclusion: 0.25 },
  };
  const engine = new PackingEngine();
  const result = JSON.parse(engine.solve_with_progress(
    JSON.stringify(triangleProblem),
    JSON.stringify({ ...options, seed: 7, max_iterations: 10_000, grid_step: 0.5, restarts: 3, baseline_only: true }),
    () => {},
  ));

  assert.ok(result.packed_item_count >= 36, JSON.stringify({
    count: result.packed_item_count,
    strategy: result.solver_strategy,
    generated: result.statistics.generated_candidates,
    exact: result.statistics.exact_geometry_checks,
  }));
  assert.match(result.solver_strategy, /^learned_motif_/);
  assert.equal(result.validation.valid, true);
  assert.ok(result.statistics.generated_candidates <= 15_000);
  assert.ok(result.statistics.exact_geometry_checks <= 6_000);
  engine.free();
});

test("Wasm studio defaults recover the validated 20-item layout", () => {
  const exclusion = Array.from({ length: 32 }, (_, index) => {
    const angle = Math.PI * 2 * index / 32;
    return { x: 15 + 2.1 * Math.cos(angle), y: 8 + 2.1 * Math.sin(angle) };
  });
  const studioProblem = {
    schema_version: 2,
    container: { parts: [{
      id: "stock", operation: "add", shape: { kind: "polygon", vertices: [
        { x: -15, y: -9 }, { x: 15, y: -9 }, { x: 15, y: 9 },
        { x: 6, y: 9 }, { x: 6, y: 6 }, { x: -15, y: 6 },
      ] }, translation: { x: 15, y: 9 }, rotation_deg: 0,
    }] },
    exclusions: [{
      id: "exclusion-a", clearance: 0.25,
      shape: { kind: "polygon", vertices: exclusion },
    }],
    items: [{
      id: "item-a", quantity: 80,
      rotation_policy: { kind: "continuous", min_deg: 0, max_deg: 360, coupling: "independent" },
      shape: { kind: "compound", parts: [
        { shape: { kind: "rectangle", width: 4, height: 2.4 }, translation: { x: 0, y: 0 }, rotation_deg: 0, snap: null },
        { shape: { kind: "circle", radius: 1.1, segments: 28 }, translation: { x: -2, y: 0 }, rotation_deg: 0,
          snap: { target_part: 0, own_anchor: "center", target_anchor: "left", offset: { x: 0, y: 0 } } },
        { shape: { kind: "circle", radius: 1.1, segments: 28 }, translation: { x: 2, y: 0 }, rotation_deg: 0,
          snap: { target_part: 0, own_anchor: "center", target_anchor: "right", offset: { x: 0, y: 0 } } },
      ] },
    }],
    fixed_placements: [],
    clearance: { item_to_item: 0.35, item_to_boundary: 0.3, item_to_exclusion: 0.25 },
  };
  const studioOptions = {
    seed: 7, deterministic: true, max_iterations: 80_000, time_limit_ms: null,
    grid_step: 0.5, restarts: 3, quality: "balanced", baseline_only: false,
  };
  const engine = new PackingEngine();
  const directProgress = [];
  const direct = JSON.parse(engine.solve_direct_with_progress(
    JSON.stringify(studioProblem),
    JSON.stringify({ ...studioOptions, max_iterations: 40_000 }),
    (json) => directProgress.push(JSON.parse(json)),
  ));
  assert.equal(direct.packed_item_count, 20);
  assert.equal(direct.validation.valid, true);
  assert.match(direct.solver_strategy, /\+contact_fill$/);
  assert.ok(directProgress.some((entry) => entry.phase === "baseline" && entry.packed_item_count === 20));
  assert.ok(direct.statistics.generated_candidates <= 450_000);
  assert.ok(direct.statistics.exact_geometry_checks <= 80_000);

  const progress = [];
  const result = JSON.parse(engine.solve_clearance_continuation_with_progress(
    JSON.stringify(studioProblem),
    JSON.stringify(studioOptions),
    (json) => progress.push(JSON.parse(json)),
  ));

  assert.equal(result.packed_item_count, 20);
  assert.equal(result.solver_strategy, "clearance_continuation");
  assert.equal(result.validation.valid, true);
  assert.equal(result.statistics.continuation_stages, 8);
  assert.ok(result.statistics.continuation_repair_only_stages > 0);
  assert.ok(progress.some((entry) => entry.phase === "clearance_continuation"));
  const continuationProgress = progress.filter((entry) => entry.phase === "clearance_continuation");
  assert.ok(continuationProgress.every((entry) => entry.packed_item_count === entry.placements.length));
  assert.ok(continuationProgress.every((entry) => entry.packed_item_count <= 20));
  assert.ok(continuationProgress.flatMap((entry) => entry.placements)
    .every((placement) => placement.x >= 0 && placement.x <= 30 && placement.y >= 0 && placement.y <= 18));
  engine.free();
});

test("Wasm sensitivity refines a parameterized compound-part transition", () => {
  const engine = new PackingEngine();
  const study = {
    parameter: { kind: "item_part_width", item_id: "item-a", part_index: 0 },
    start: 2,
    end: 4,
    initial_step: 1,
    transition_tolerance: 0.05,
    strategy: "adaptive",
    solve_options: options,
    seed_policy: "fixed",
    increasing_is_harder: true,
  };
  const progress = [];
  const result = JSON.parse(engine.sensitivity_with_progress(
    JSON.stringify(problem),
    JSON.stringify(study),
    (json) => progress.push(JSON.parse(json)),
  ));
  const capacities = new Set(result.evaluations.map((entry) => entry.capacity));

  assert.ok(capacities.size >= 2);
  assert.equal(progress.length, result.evaluations.length);
  assert.equal(progress[0].phase, "sampling");
  assert.ok(progress.some((entry) => entry.phase === "refining"));
  assert.ok(result.transitions.length >= 1);
  assert.equal(result.evaluations.every((entry) => entry.problem.items.length === 1), true);
  assert.ok(result.transitions.every((entry) => entry.upper_value - entry.lower_value <= 0.05 + 1e-9));
  assert.deepEqual(result.warnings, []);
  engine.free();
});
