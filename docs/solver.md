# Solver

## Structured patterns

Each prepared variant supplies a width, height, geometry, item identity, and permitted rotation. Structured runs scan regular rows from both horizontal origins, stagger every second row by half a pitch, and scan columns from both vertical origins. Pitch includes the requested item separation and a small numeric guard. Concave boundaries and exclusions naturally reject positions that a rectangular pattern proposes outside usable space.

Variants are ordered by width or height for the primary runs. Seeded restarts deterministically shuffle them. Trying each rotation sequentially also allows later variants to fill gaps left by earlier orientations without introducing a separate alternating-pattern abstraction.

## Greedy candidates and scoring

Greedy insertion combines:

- container bounding-box corners;
- positions adjacent to each placed item on four sides;
- positions adjacent to exclusion bounds;
- a configurable coarse grid across the container bounds.

Candidates are sorted by `y` and then `x`, deduplicated with the geometry epsilon, and evaluated in that order. This is an explicit bottom-left compactness preference. Feasibility uses cached bounding boxes before polygon work. Counts and a stable placement transform key choose between completed layouts. Candidate, valid-candidate, and iteration counters make strategy behavior visible.

This scoring is intentionally modest. Balance, centreline distance, regularity, preserved future positions, and conflict graphs should be added only when representative cases demonstrate value and can compare the resulting layouts.

## Local improvement

After structured and greedy insertion, non-fixed placements move left and then down in grid-sized increments while the layout stays valid. This bounded compaction can open candidate space and proves an improvement stage independent of initial construction. It is not a general local-search framework: it does not yet remove groups, exchange item types, or explore a full rotation neighborhood.

## Determinism, limits, and progress

The portfolio uses ordered vectors, `BTreeMap` result counts, total float ordering, and `ChaCha8Rng` seeded only from `SolveOptions.seed` and the restart number. Equal problem, options, and seed therefore produce the same layout, strategy, and search counts in deterministic mode; `elapsed_ms` naturally varies. Deterministic mode rejects a wall-clock limit because time cannot define a reproducible stopping candidate. Set `deterministic` to `false` to opt into time-bounded execution, or retain the default and use the iteration bound.

The loop checks the maximum iteration count, native time budget, and `SolveObserver::should_cancel`. It reports complete best-placement snapshots after portfolio attempts through `on_progress`. The observer is deliberately a pair of callbacks rather than an event system. In the browser, a Web Worker owns the Wasm instance, forwards those snapshots, and provides immediate cancellation by termination; a replacement worker is created for the next run.

## Feasibility and optimality

Every returned placement set is independently validated. That proves geometric feasibility, not packing optimality. `BestFound` means the selected valid heuristic result after the configured portfolio. `LimitReached` and `Cancelled` preserve the best valid result available at termination. `ProvenOptimal` requires equality with the safe simple upper bound; because that bound is loose, this is uncommon.

Failure modes include sparse candidate sets for tightly interlocking shapes, polygon approximation error for low-segment circles, weak layouts when grid step is too coarse, costly scans when it is too fine, and geometry near the numeric epsilon. Sensitivity runs can also reveal inconsistent heuristic capacities. Those are reported verbatim instead of forced into a monotonic curve.
