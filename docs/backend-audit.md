# Backend audit

This document tracks the structural review of the Rust workspace. A refactor is complete only when superseded code is removed and formatting, linting, native tests, CLI behavior, and the Wasm boundary remain verified.

## Current architecture

| Area | Module | Responsibility | Audit status |
| --- | --- | --- | --- |
| Public domain model | `packing-core/model/{problem,solve,sensitivity}.rs` | Serialized problem, solve, progress/result, and sensitivity contracts | Split by compatibility/change axis and re-exported through the existing API |
| Geometry kernel | `packing-core/geometry.rs`, `geometry/region.rs` | Tessellation/transforms/predicates and Boolean region construction | Overlay ownership separated from the exact geometry kernel |
| Preparation | `packing-core/prepare.rs` | Validation-backed normalization, variants, contacts, and safe bounds | Cohesive pipeline |
| Solve orchestration | `packing-core/solver.rs` | Public solve APIs and portfolio scheduling | Facade over `portfolio`, `continuation`, `annealing`, `result`, and `warm_start` modules |
| Constructive portfolio | `solver/portfolio.rs`, `solver/portfolio/learned.rs` | Generic placement/local improvement and learned lattice/motif strategies | Split by algorithm family |
| Beam search | `packing-core/search.rs`, `search/candidate_pipeline.rs`, `search/conflict_graph.rs` | Beam state/bounds, candidate feasibility/scoring, and finite graph proof | Split by invariant and proof scope |
| Overlap repair | `packing-core/overlap.rs`, `overlap/penalty.rs` | Guided one-more-item repair and conflict penalties | Repair schedule and penalty model separated |
| Sensitivity | `packing-core/sensitivity.rs`, `sensitivity/parameter.rs` | Study execution/refinement and schema-path mutation | Orchestration and mutation separated |
| Independent validation | `packing-core/validate.rs` | Input validation and independent placement validation | Clear correctness boundary |
| Shared runtime foundations | `clock.rs`, `numeric.rs` | Cross-target instrumentation clock and canonical angular tolerance | One implementation used across algorithms |
| Native/Wasm adapters | `packing-cli`, `packing-wasm` | JSON transport and progress adapters | Narrow; one generic Wasm progress callback bridge |
| Integration coverage | `packing-core/tests/*_workflows.rs`, `tests/common` | Geometry, domain, core solve, strategy, and benchmark workflows | Split by ownership with shared fixtures |

## Findings

### 1. Solver catch-all

`solver.rs` combines at least seven stable responsibilities: API/orchestration, constructive portfolios, learned lattice and motif layouts, clearance continuation, specialized capsule annealing, result/statistics assembly, and warm-start repair. Its private scope hides coupling rather than making those responsibilities easier to understand. These algorithms should become sibling modules around a small solver facade and explicit shared run context.

Completed: these responsibilities are now sibling modules. `solver.rs` retains the public facade and sequential portfolio schedule; `ResultParts` makes result finalization inputs explicit rather than relying on an eight-argument builder.

### 2. Search pipeline coupling

`search.rs` combines candidate representation and generation, spatial indexing, feasibility/scoring, safe upper bounds, beam ordering, and a finite conflict-graph solver. The candidate pipeline and graph proof have distinct invariants and test needs.

Completed: candidate generation/spatial feasibility and finite conflict-graph proof are separate modules. Beam state ordering and safe bound accounting remain in `search.rs`.

### 3. Geometry layering

`geometry.rs` combines shape tessellation and compound dependency resolution with Boolean overlay conversion and low-level computational-geometry predicates. The public geometry representation is useful, but consumers should share canonical angle and segment operations rather than retaining solver-specific copies.

Completed: Boolean region construction and overlay conversion live in `geometry/region.rs`. Exact segment distance remains authoritative in the geometry kernel. The capsule annealer retains a separately named and documented permissive surrogate metric because the protected 21-item regression proves it is search policy, not an interchangeable exact predicate.

### 4. Duplicated foundations

Angular distance and rotation equality are independently implemented in solver, search, overlap repair, and validation. Segment intersection/distance is duplicated by the geometry kernel and the continuation annealer. Clock adapters repeat in solver, search, overlap, and preparation. These should have canonical homes with intentionally documented tolerance semantics.

Completed: `numeric.rs` owns angular distance and rotation equality; `clock.rs` owns native/Wasm timing behavior. Exact and surrogate segment metrics are intentionally distinct and named by semantics.

### 5. Sensitivity mutation mixed with execution

Study evaluation/refinement and schema-path mutation evolve for different reasons. Parameter mutation should be independently testable and reusable without importing sensitivity orchestration.

Completed in `sensitivity/parameter.rs`; study evaluation and adaptive refinement remain in the sensitivity facade.

### 6. Test ownership

The integration suite proves important behavior but its single file obscures ownership and makes targeted runs difficult. Tests should be grouped by geometry/preparation, core solve workflows, advanced search quality, and sensitivity while preserving every existing assertion.

Completed: the original 25 workflows are grouped into five targeted binaries, and a regression now protects unique strategy provenance.

## Completion gates

- The solver facade no longer contains complete implementations of unrelated search families.
- Shared numeric and geometric concepts have one implementation and explicit tolerance semantics.
- Sensitivity orchestration and parameter mutation have separate module boundaries.
- Search candidate/beam behavior and finite conflict-graph proof logic have clear ownership.
- Native and Wasm adapters contain transport/lifecycle logic only, with no copied solver rules.
- Legacy implementations are removed as each extraction lands.
- `cargo fmt --check`, strict Clippy, all workspace tests, CLI smoke tests, and browser Wasm runtime tests pass.
- Final file-size and duplicate-symbol audits justify remaining large modules by cohesive responsibility.

## Final verification

- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Native workspace tests: passed 31/31 across unit, geometry, domain, core solve, strategy, and benchmark binaries.
- CLI smoke tests: validation and target feasibility passed with independently valid JSON output.
- Warning-free workspace documentation: passed with `RUSTDOCFLAGS=-D warnings`.
- Fresh Wasm release build: passed; generated binary reduced from approximately 1.62 MB to 1.17 MB after current toolchain optimization.
- Browser Wasm runtime suite: passed 6/6, including direct 20 and continuation 21 solver witnesses.
- Duplicate-symbol audit: clean. Helpers with different contracts are named explicitly (`polygon_contact_points`, `polygon_set_contact_points`, and `capsule_surrogate_point_segment_distance`).
