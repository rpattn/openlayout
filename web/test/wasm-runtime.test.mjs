import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PackingEngine, initSync } from "../src/wasm/packing_wasm.js";

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
};

test("Wasm engine validates, streams layouts, and reuses deterministic preparation", () => {
  const engine = new PackingEngine();
  assert.deepEqual(JSON.parse(engine.validate(JSON.stringify(problem))), { valid: true });
  const progress = [];
  const first = JSON.parse(engine.solve_with_progress(
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
