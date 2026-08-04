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

After structured and greedy insertion, non-fixed placements move left and then down in grid-sized increments while the layout stays valid. Permitted variants are then tried in place. Finally, a bounded destroy/repair neighbourhood selects several boundary placements, removes each one with its two nearest movable neighbours, and greedily reinserts the released quantities across the strategy's rotation order. A trial replaces the incumbent only when it packs more items or has a deterministic lower layout key; fixed placements are never removed. This is deliberately a small interactive neighbourhood, not an unbounded metaheuristic or full item-type exchange search.

## Determinism, limits, and progress

The portfolio uses ordered vectors, `BTreeMap` result counts, total float ordering, and `ChaCha8Rng` seeded only from `SolveOptions.seed` and the restart number. Equal problem, options, and seed therefore produce the same layout, strategy, and search counts in deterministic mode; `elapsed_ms` naturally varies. Deterministic mode rejects a wall-clock limit because time cannot define a reproducible stopping candidate. Set `deterministic` to `false` to opt into time-bounded execution, or retain the default and use the iteration bound.

The loop checks the maximum iteration count, native time budget, and `SolveObserver::should_cancel`. It reports complete best-placement snapshots after portfolio attempts through `on_progress`. The observer is deliberately a pair of callbacks rather than an event system. In the browser, a Web Worker owns the Wasm instance, forwards those snapshots, and provides immediate cancellation by termination; a replacement worker is created for the next run.

Learned lattices may use the first 25% of the global budget and complementary motifs may extend learning through 40%; the remaining budget is shared fairly between general portfolio attempts. Within each attempt the shares are 30% structured placement, 55% greedy insertion, 7% compaction, 4% in-place rotation, and 4% remove/reinsert improvement. This prevents any one grid or motif sweep from starving later orientations and strategies. Fast and balanced respect the base iteration budget; thorough uses four times that budget and adds top-down, right-to-left, and extra seeded attempts. For a sensitivity parameter declared monotonic, a better layout from a harder point is carried to easier points only after independent validation against the easier geometry.

Before the general portfolio, the solver learns small repeatable packing cells directly from exact geometry predicates. For each rotation it measures the minimum safe row separation at aligned and half-shifted offsets; this recovers rectangular grids and hexagonal disk rows without testing the shape kind. For independent rotation policies it also aligns vertices and edge midpoints between pairs of variants, ranks the resulting non-overlapping motifs by bounding-box waste, and tiles the strongest motifs. Complementary triangles therefore become a square cell automatically. Concave, holed, or disconnected fields are split at container and exclusion coordinates into a bounded set of exact non-overlapping rectangular regions; each region receives an independently aligned lattice seed. These are bounded local analogues of no-fit-polygon placement: inexpensive enough for an interactive first solution, while every generated placement still passes ordinary feasibility and final independent validation.

This direction follows established irregular-packing results: bottom-left placement becomes substantially stronger when driven by no-fit contact geometry, and competitive methods combine constructive placement with local or metaheuristic improvement. See Burke et al., [A New Bottom-Left-Fill Heuristic Algorithm](https://doi.org/10.1287/opre.1060.0293), Burke et al., [Irregular Packing Using the Line and Arc No-Fit Polygon](https://doi.org/10.1287/opre.1090.0770), and Imamichi et al., [Iterated Local Search for Irregular Strip Packing](https://doi.org/10.1016/j.disopt.2009.04.002).

## Feasibility and optimality

Every returned placement set is independently validated. That proves geometric feasibility, not packing optimality. `BestFound` means the selected valid heuristic result after the configured portfolio. `LimitReached` and `Cancelled` preserve the best valid result available at termination. `ProvenOptimal` requires equality with the safe simple upper bound; because that bound is loose, this is uncommon.

Failure modes include sparse candidate sets for tightly interlocking shapes, polygon approximation error for low-segment circles, weak layouts when grid step is too coarse, costly scans when it is too fine, and geometry near the numeric epsilon. Sensitivity runs can also reveal inconsistent heuristic capacities. Those are reported verbatim instead of forced into a monotonic curve.
