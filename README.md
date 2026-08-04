# OpenLayout

OpenLayout is a private prototype engine and browser studio for generic two-dimensional constrained packing. Schema v2 accepts Boolean containers assembled from additive material and subtractive cut-outs, exclusions, parameterized primitive or compound item shapes, adaptive or discrete rotations, fixed placements, and clearances; prepares reusable geometry; runs a deterministic solver portfolio; independently validates the selected layout; and can sweep a numeric parameter to locate packing-capacity transitions.

The project proves the complete computational and interaction path in one local application. There is no service, persistence layer, public API commitment, or release machinery. Breaking changes are expected whenever they improve the experiment.

## Current capabilities

- Polygon, rectangle, triangle, polygonized-circle, closed cubic Bézier, and compound shapes with transforms
- Concave single-polygon containers and polygonal exclusions
- Uniform item, boundary, and exclusion clearances
- Finite or effectively unlimited quantities, continuous/discrete rotation domains, and fixed placements
- Independent-copy or shared-per-item angle coupling, with coarse and edge-aligned adaptive candidates
- Boolean-unioned material, structural holes, disconnected islands, and normalized compound solids
- Shape-agnostic learned lattices, exact container-region seeds, and complementary two-piece motifs for dense repeated patterns
- Row, column, staggered, seeded greedy, contact, grid, compacting, rotation, and bounded remove/reinsert strategies
- Deterministic seeded portfolios with iteration/time limits and an observer for progress or cancellation
- Independent validation of every selected result
- Sampled and adaptively refined sensitivity studies with non-monotonicity warnings
- Structured results containing transforms, counts, strategy, bounds, search statistics, validation, and warnings
- The same `packing-core` library behind a native CLI and a thin `wasm-bindgen` adapter
- A local TypeScript studio for composing multi-part shapes, configuring runs, rendering incremental layouts, cancelling workers, and inspecting sensitivity transitions with live study progress
- A canvas-first shape modeller with direct dragging, nine-point snapping, constraint editing, and visual sensitivity extremes

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
cargo run -p packing-cli -- sensitivity examples/sensitivity-problem.json examples/sensitivity-study.json
cargo run -p packing-cli -- sensitivity examples/snapped-compound.json examples/snapped-width-study.json
```

`solve` optionally accepts a third JSON file containing `SolveOptions`. Output is formatted JSON on stdout, making a representative command a repeatable manual benchmark: the result includes `statistics.elapsed_ms`, candidate counts, and iteration count. Deterministic mode is enabled by default and accepts iteration limits, not wall-clock limits; set `deterministic` to `false` when a time cutoff matters more than an identical stopping point.

Install `wasm-pack`, then build the browser package with:

```bash
wasm-pack build crates/packing-wasm --target web --out-dir ../../pkg
```

To run the complete visual studio instead:

```bash
cd web
npm install
npm run dev
```

Open the local URL printed by Vite. `npm run build` generates the Wasm bindings, type-checks the application, and creates a production bundle. `npm test` generates the same Wasm module and exercises progress delivery, prepared-problem reuse, deterministic layouts, and compound-part sensitivity directly against the WebAssembly runtime. For the real-browser workflow checks, run `npx playwright install chromium` once and then `npm run test:e2e`.

The studio can interactively edit multiple additive or subtractive polygonal/Bézier container parts, exclusions, and item definitions from transformed rectangle, triangle, circle, polygon, and Bézier parts; select adaptive or fixed rotation and angle coupling; preserve fixed placements; set clearances and deterministic solve limits; import or export schema-v2 JSON; watch phased progress and improving layouts; stop a run by terminating its worker; toggle concise dimension and dashed clearance overlays; inspect validation and solver statistics; and select exact evaluated layouts from a scrollable sensitivity graph.

The **Shape modeller** tab provides the canvas-first geometry workflow for items, the container, and exclusions. Select or add parts, replace a boundary type, drag geometry directly, resize or rotate with handles, edit Bézier knots and tangents, or enter exact dimensions and transforms in the inspector. Dimensions and effective clearance are shown in-place. Moving an item anchor near another part’s center, edge midpoint, or corner creates a live snap constraint. A snapped part follows its target when target dimensions or rotation change. The lower strip previews the configured sensitivity start, intermediate steps, and end geometry before solving. See [shape modeller details](docs/modeller.md).

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

This remains a heuristic prototype. It does not compute no-fit polygons, prove infeasibility in general, or provide strong combinatorial upper bounds. Candidate generation and adaptive angle refinement are intentionally bounded, while exact final validation remains mandatory. See [solver details](docs/solver.md) and the [roadmap](docs/roadmap.md).

Reference fixtures keep generic pattern learning honest: `2×2` rectangles tile a `10×6` field with exactly 15 items, complementary right triangles tile a `10×10` field with exactly 50 items and reach `ProvenOptimal`, offset disconnected fields align independently, and unit disks discover a five-row hexagonal lattice containing `5+4+5+4+5 = 23` disks without circle-specific solver code. The original snapped-capsule sensitivity case also holds at least 17 items at width `4.375` with half its former effective search budget. “Sphere packing” in this two-dimensional engine means disk packing; true 3D spheres are outside its model.
