# OpenLayout

OpenLayout is a private prototype engine and browser studio for generic two-dimensional constrained packing. Schema v2 accepts Boolean containers assembled from additive material and subtractive cut-outs, exclusions, parameterized primitive or compound item shapes, adaptive or discrete rotations, fixed placements, and clearances; prepares reusable geometry; runs a deterministic solver portfolio; independently validates the selected layout; and can sweep a numeric parameter to locate packing-capacity transitions.

The project proves the complete computational and interaction path in one local application. There is no service, server-side persistence, public API commitment, or release machinery. Browser projects persist only in versioned on-device storage. Breaking changes are expected whenever they improve the experiment.

## Current capabilities

- Polygon, rectangle, triangle, polygonized-circle, closed cubic Bézier, and compound shapes with transforms
- Concave single-polygon containers and polygonal exclusions
- Uniform item, boundary, and exclusion clearances
- Finite or effectively unlimited quantities, continuous/discrete rotation domains, and fixed placements
- Independent-copy or shared-per-item angle coupling, with coarse and edge-aligned adaptive candidates
- Boolean-unioned material, structural holes, disconnected islands, and normalized compound solids
- Shape-agnostic learned lattices, exact container-region seeds, and complementary two-piece motifs for dense repeated patterns
- Row, column, staggered, seeded greedy, explicit contact/grid candidates, bounded beam search, compacting, rotation, and remove/reinsert strategies
- Safe area, disconnected-region, quantity, and certified rectangular projection bounds with state pruning
- Target-count feasibility solving and optional finite conflict-graph refinement in thorough mode
- Deterministic seeded portfolios with iteration/time limits and an observer for progress or cancellation
- Independent validation of every selected result
- Warm-started sampled and adaptively refined sensitivity studies with non-monotonicity warnings
- Structured results containing transforms, counts, strategy, bounds, search statistics, validation, and warnings
- The same `packing-core` library behind a native CLI and a thin `wasm-bindgen` adapter
- A local TypeScript studio with on-device projects, switching, automatic/manual saves, bounded undo/redo, and light/dark themes
- Dedicated Packing, unified canvas Modeller, and Sensitivity workspaces with incremental layouts, cancellation, visual geometry extremes, and transition inspection

The workspace is deliberately small:

```text
crates/packing-core   geometry, preparation, solving, validation, sensitivity
crates/packing-cli    native JSON inspection commands
crates/packing-wasm   JSON-in/JSON-out WebAssembly adapter
web                   Vite/TypeScript editor, Web Worker, renderer, and Wasm runtime tests
examples              neutral problem, study, and JavaScript inputs
docs                  architecture, solver notes, and roadmap
```

## Build and run

Rust 1.85 or newer is required because the workspace uses the Rust 2024 edition.

```bash
cargo build --workspace
cargo test --workspace

cargo run -p packing-cli -- validate examples/irregular-rectangles.json
cargo run -p packing-cli -- solve examples/irregular-rectangles.json
cargo run -p packing-cli -- solve examples/compound-with-exclusion.json
cargo run -p packing-cli -- feasible examples/irregular-rectangles.json 18
cargo run -p packing-cli -- sensitivity examples/sensitivity-problem.json examples/sensitivity-study.json
cargo run -p packing-cli -- sensitivity examples/snapped-compound.json examples/snapped-width-study.json
```

`solve` optionally accepts a third JSON file containing `SolveOptions`; `feasible` accepts a target count and then the same optional file. The three quality modes are `fast` (greedy portfolio), `balanced` (small beam plus local repair), and `thorough` (larger beam and optional conflict graph). Output is formatted JSON on stdout and includes phase timings, geometry checks, state counts, bounds, repair, warm-start, graph, and validation statistics. Deterministic mode is enabled by default and accepts iteration limits, not wall-clock limits; set `deterministic` to `false` when a time cutoff matters more than an identical stopping point.

Install `wasm-pack`, then build the browser package with:

```bash
cd web
npm run wasm
```

To run the complete visual studio instead:

```bash
cd web
npm install
npm run dev
```

Open the local URL printed by Vite. `npm run build` type-checks the application and creates a production bundle from the checked-in Wasm artifact. Run `npm run build:wasm` when Rust sources change; CI regenerates the artifact and rejects drift. `npm test` regenerates the same Wasm module and exercises progress delivery, prepared-problem reuse, deterministic layouts, and compound-part sensitivity directly against the WebAssembly runtime. For the real-browser workflow checks, run `npx playwright install chromium` once and then `npm run test:e2e`.

The studio stores multiple named projects entirely in browser `localStorage`; projects can be created, switched, renamed, duplicated, explicitly saved, or removed and survive browser and device restarts. Workspace edits also auto-save. Undo/redo uses bounded state snapshots and supports toolbar buttons plus standard keyboard shortcuts. The theme preference is stored beside the projects.

The read-only **Packing** geometry overview shows the container, exclusions, and each item definition without exposing source transforms. It retains clearance and deterministic run configuration, phased progress, cancellation, result metrics, diagnostics, and dimension/clearance overlays. All geometry definition, transform, rotation, Boolean-region, exclusion, and fixed-placement edits live in the **Modeller**.

The unified **Modeller** creates and deletes item definitions, additive material, subtractive cut-outs, and exclusions from one target selector. Select or add parts, replace a boundary type, drag geometry directly, resize or rotate with handles, edit Bézier knots and tangents, manage fixed placements, or enter exact dimensions and transforms in the inspector. Independent toggles control in-place dimensions and effective-clearance outlines. Moving an item anchor near another part’s center, edge midpoint, or corner creates a live snap constraint. See [shape modeller details](docs/modeller.md).

The dedicated **Sensitivity** workspace owns the parameter, range, sampling, seed, run progress, capacity graph, transitions, and selected-result layout. Its geometry strip previews start, intermediate, and end states for item, clearance, exclusion, and container parameters; container studies therefore show the field itself changing rather than an unrelated item preview.

[`examples/wasm-usage.js`](examples/wasm-usage.js) shows module loading, solving, reading placements, and sensitivity execution. The Wasm exports are `validate_problem`, `solve_problem`, and `run_sensitivity`.

## Minimal native use

```rust
use packing_core::{PackingProblem, SolveOptions, solve};

let problem: PackingProblem = serde_json::from_str(problem_json)?;
let result = solve(&problem, &SolveOptions::default())?;
assert!(result.validation.valid);
for placement in result.placements {
    println!("{} at {}, {}", placement.item_id, placement.x, placement.y);
}
```

All coordinates are `f64` values in one caller-selected linear unit. No unit conversion occurs. Shapes are treated as closed polygonal regions, circles and Bézier spans use their requested segment counts, and comparisons use a documented epsilon rather than float equality. Compound snaps use nine points on each part’s oriented local frame: center, four edge midpoints, and four corners. Item-to-item separation `d` is enforced as a total physical boundary distance of at least `d`; this is equivalent to expanding each item collision envelope by `d / 2`. Boundary clearance is the distance from the physical item boundary to the container boundary. Exclusion clearance is the greater of the problem-wide and per-exclusion values.

## Examples and limitations

`irregular-rectangles.json` should produce repeated rectangular placements while respecting the container notch. `compound-with-exclusion.json` exercises a multi-part item around a central unavailable region. The sensitivity pair changes a rectangle width and should expose several discrete capacity regions and narrow transition intervals. The studio opens with an editable neutral example combining all three parameterized primitives.

This remains a heuristic prototype. It does not compute no-fit polygons or prove infeasibility in general. A result is globally proven only when its feasible count meets a safe unrestricted bound; conflict-graph optimality applies only to the generated finite candidate set. Candidate generation, beam breadth, local repair, graph search, and adaptive angles are bounded, while exact final validation remains mandatory. See [solver details](docs/solver.md), the [solver review and literature map](docs/solver-review.md), [published benchmark validation](docs/benchmarks.md), [performance notes](docs/performance.md), [deployment notes](docs/deployment.md), and the [roadmap](docs/roadmap.md).

Reference fixtures keep generic pattern learning honest: `2×2` rectangles tile a `10×6` field with exactly 15 items, complementary right triangles tile a `10×10` field with exactly 50 items and reach `ProvenOptimal`, offset disconnected fields align independently, and unit disks discover a five-row hexagonal lattice containing `5+4+5+4+5 = 23` disks without circle-specific solver code. The original snapped-capsule sensitivity case also holds at least 17 items at width `4.375` with half its former effective search budget. “Sphere packing” in this two-dimensional engine means disk packing; true 3D spheres are outside its model.
