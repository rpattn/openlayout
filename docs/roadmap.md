# Roadmap

Work is ordered by evidence needed for the private planning tool. Stages describe the next useful proof, not compatibility or release promises.

## Stage 1: complete concept proof

This repository establishes the first vertical slice: core polygon geometry, explicit clearances, irregular containers, exclusions, primitive and compound items, structured and greedy packing, bounded compaction, independent result validation, sampled and adaptive sensitivity sweeps, Wasm execution, and native JSON inspection. Representative generic inputs and five integration tests protect the important behavior.

Remaining Stage 1 work should be driven only by failures found while exercising those examples: tighten geometric predicates if a reproducible valid input defeats them, and compare CLI results across native and Wasm runtimes.

## Stage 2: frontend-ready engine

The first frontend now runs against the current JSON: it provides stable-enough internal field names for this one application, deterministic layout identifiers, cached prepared geometry for solve-only changes, direct parameter editing for compound primitives, and a canvas modeller with persistent anchor constraints.

Wasm runs in a Web Worker with progress snapshots, cancellation, and incremental best results without making browser threads a core requirement. The studio preserves and renders representative sensitivity layouts, exposes transition diagnostics, and reports malformed geometry. Continue refining this interaction only from actual use; none of it is a compatibility promise.

## Stage 3: stronger packing quality

Expand the current reference corpus and compare every algorithm change against it. Learned contact lattices, complementary motifs, field decomposition, in-place rotation, and a bounded three-item remove/reinsert neighbourhood now provide the first quality baseline. Evaluate full no-fit polygons or conflict-graph candidate selection only where the corpus demonstrates that the bounded contact methods remain weak.

Develop useful shape-aware upper bounds, warm-start adjacent sensitivity cases, and make transition refinement reuse nearby layouts. Compare strategies by capacity, runtime, and validation failures. Treat consistent transition locations—not isolated best counts—as a solver-quality metric.

## Stage 4: production robustness

Production means dependable enough for the intended private interactive planning application. Replace or reinforce geometric predicates with a robust clipping/offset kernel where adversarial inputs show need. Establish deterministic fixtures across native and Wasm builds, cancellation latency for long solves, browser memory ceilings, and representative performance targets.

Fuzz malformed inputs without turning the project into a public hardening exercise. Continue validating every returned layout. Recover from individual failed sensitivity points and retain diagnostics. Add persistence-ready result records and export-ready transformed geometry only when the application begins saving or exporting work. Express operational constraints through generic regions, metadata, and explicit scoring terms, keeping application interpretation outside the engine.

## Stage 5: optional later possibilities

These are not part of the current goal and should not shape current abstractions: richer frontend integration, DXF or SVG import, more advanced optimization, multithreaded browser execution, public packaging, stable APIs, broader documentation, and public-repository polish. Adopt any of them only when actual use demonstrates the need.
