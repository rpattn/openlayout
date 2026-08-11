# Solver

The core separates immutable geometry preparation from bounded search. Every successful path ends in `validate_placements`, which reconstructs geometry from the input model; search-state geometry is never trusted as final proof.

## Original baseline and measured hot path

The retained baseline learns repeated lattices and two-variant motifs, seeds non-overlapping rectangular subregions, tries structured rows, staggered rows and columns, then performs bottom-left contact/grid insertion. Directional compaction, in-place rotation, and a three-item remove/reinsert neighbourhood complete each portfolio attempt. `fast` runs this baseline and remains the lowest-latency mode and lower-bound source.

Before bounded search was added, the expensive repeated work was candidate transformation, containment, exclusion distance, and pair collision checks. A full grid/contact list and placed-geometry scan were rebuilt after placements; subdivision coordinates were rebuilt for each solve; transformed geometry lived in every accepted candidate. Preparation already avoided the worst repetition by polygonizing and rotating once, but its cost was not visible.

`SolveStatistics` now records preparation, candidate generation, containment, collision, scoring and subdivision time; generated and accepted candidates; broad-phase rejections and exact geometry checks; explored, deduplicated and pruned states; lower and upper bounds; local and overlap repair; warm starts; and conflict-graph work. Timers are deliberately coarse and removable. Operation counts are the more stable comparison. See [performance](performance.md).

## Prepared geometry and geometric staging

`PreparedProblem` owns the normalized container and exclusions, usable area, cached boundaries and bounds, item indexes, and every permitted rotation variant. Each variant has a stable run-local integer identifier, normalized polygon set, bounding box, and guaranteed occupied area. Equivalent rotations are removed geometrically. Search candidates refer to a variant identifier and transform rather than storing a polygon copy.

Feasibility is staged:

1. reject a candidate outside the container bounding box;
2. test exact containment and boundary clearance;
3. reject non-overlapping exclusion and placement bounds;
4. query nearby placements through a deterministic uniform spatial index;
5. perform polygon overlap and distance checks only on broad-phase matches.

The index is small and state-local. Copying it would cost more complexity than rebuilding it once per expanded state at current beam widths. Accepted placements cache transformed geometry in shared immutable references, so cloning a beam state copies small placement records rather than every polygon coordinate array.

## Explicit contact candidates

A candidate contains a stable identifier, prepared variant, reference position, translated bounds, source category, and transient score. Sources are container vertices and edge midpoints, exclusion contacts, placed-item contacts, simultaneous vertex alignments, container extrema, and a quality-dependent structured grid. Positions are quantized and deduplicated, then totally ordered. Boundary clearance is included in extrema and grid origins.

The state-independent container, exclusion, grid, and fixed-placement frontier is generated once at the root and filtered by remaining quantities. Each state generates only contacts involving its movable placements. Contact candidates receive a modest ordering bonus, followed by extrema and structured positions. For polygon sets of at most 16 vertices, duplicate vertex/edge contact constructions are retained as a capped support count: multi-contact exact-fit candidates rank ahead of arbitrary single contacts. More complex sampled curves and compound shapes keep a small dynamic frontier to prevent quadratic candidate growth. Alignment, bottom-first compactness, and a stable identifier break ties. Feasibility always precedes state scoring, and packed count always dominates secondary compactness.

Full no-fit polygons were investigated but not adopted. The current geometry stack supplies reliable Boolean overlay but no robust Minkowski/no-fit operation with holes, disconnected solids, and clearance conventions. Vertex/midpoint contacts plus learned separation give useful touching placements without a fragile partial NFP. If an NFP is later justified, its cache must remain isolated and define whether coordinates represent physical boundaries or half-clearance envelopes.

## Beam search, ordering, and deduplication

`balanced` retains eight states and expands up to twelve feasible children per state. `thorough` retains twenty-four and expands up to twenty-four; it receives the larger iteration budget already associated with that mode. `fast` skips the beam unless an explicit beam width is supplied. Four experimental overrides—beam width, candidates per state, search-state limit, and candidate density—cover useful investigations without exposing every internal weight. A width-one configuration follows the same expansion and ordering rules as a single-path constructive solve.

A state contains selected placement records, per-item counts, a secondary score, and its optimistic upper bound. It references prepared variants and clones only the modest selected-placement vector. Branch ordering prefers the largest bound, then packed count, compactness, and the canonical signature. The signature sorts `(variant, quantized x, quantized y)` records, preventing insertion-order duplicates while using a fine enough quantum to avoid merging materially different futures.

The baseline layout initializes the lower bound. Therefore bounded modes cannot return fewer items than their completed greedy portfolio. The beam starts from fixed placements so it can explore genuinely different construction paths rather than only append to the incumbent.

Repeated-item pattern learning includes both single-orientation lattices and complementary
two-orientation motifs. Motifs begin at vertex or edge-midpoint contacts. With positive pair
clearance, the second shape is moved along the contact direction until exact geometry reaches the
requested separation; the solver then learns horizontal and vertical repeat distances from the
whole two-shape motif. This matters for triangles: advancing by an axis-aligned bounding box
throws away the interlocking space, while disabling motifs at positive clearance leaves the
general portfolio to rediscover a basic alternating row one placement at a time.

Before a repeated-item portfolio moves from learned lattices and motifs into coarse and refined
angle search, the incumbent is closed under a bounded contact-only insertion pass. It first reuses
orientations already present in the layout, then orthogonal edge-aligned variants, and immediately
rescans a variant after a successful insertion so the new contacts can expose another easy fit.
The same cheap closure runs after compaction and in-place rotation for general portfolios. It
deliberately skips the structured grid already scanned by the greedy pass. On the studio capsule
fixture this turns the 18-piece learned lattice into the validated 20-piece layout during
`baseline`, before angle refinement.

`SolveOptions.baseline_only` returns at this boundary after normal independent validation. It is a
quick solution-quality check, not an alias for `fast`: the selected quality still controls the
pre-boundary iteration multiplier, while the option explicitly skips portfolio rotations,
continuation, neighbourhood repair, beam search, and conflict-graph refinement.

For a single continuously rotatable item whose prepared outline has more than 16 vertices, the
portfolio stops after two structurally different attempts fail to improve the contact-closed
incumbent. This complexity-aware stagnation rule still probes rows and staggered rows, but avoids
spending the remainder of a deterministic budget on equivalent curved-shape angle orders. Any
improvement resets the counter, and low-complexity polygons retain the complete angle portfolio.

## Valid upper bounds

The tightest applicable bound is used:

- The area/quantity bound subtracts guaranteed occupied area and divides by the smallest remaining guaranteed item area. Exclusions are intentionally not subtracted because they may overlap.
- The split-region bound sums contour capacities only when every item solid is connected. Hole contours are treated as extra usable area, which can only loosen the result; disconnected items disable this bound because they could span components.
- The projection bound is enabled only when every variant is its complete axis-aligned bounding rectangle. It packs minimum width and height projections into the container bounding box. Other geometry disables the bound rather than risking an underestimate.

Bounds are conservative. A state is pruned only when it cannot exceed the validated lower bound. Per-bound prune counters make this testable. Equality between a feasible count and the unrestricted safe bound permits `ProvenOptimal`; conflict-graph proof has a narrower meaning described below.

## Local improvement

Non-fast modes retain the bounded remove-and-repack pass. It chooses deterministic boundary anchors, removes the anchor and up to two nearest movable placements, rebuilds candidates through greedy insertion, and accepts a higher count or a stable equal-count compactness improvement. Fixed placements are never removed. Attempts and accepted changes are reported. This is intentionally not a generic metaheuristic framework.

## Guided overlap-minimizing repair

Balanced and thorough solves now add one requested item to the strongest feasible incumbent and
temporarily permit item-to-item conflicts. Seeds first reuse high-quality placements rejected by
the constructive portfolio, then fall back to overlapping the new item with incumbent anchors.
Container and exclusion constraints remain hard throughout, fixed placements never move, and
shared-rotation coupling remains enforced.

The repair objective follows Umetani et al.'s overlap-minimization formulation: every conflicting
item pair contributes the minimum estimated horizontal or vertical translation required to
separate the exact transformed polygons at the requested clearance. For each movable item and
allowed orientation, the solver searches container extrema, pair-contact events, nearby steps,
and a bounded line grid; horizontal and vertical searches alternate and ties prefer the nearest
position. Fast active neighborhoods revisit only pieces affected by an accepted move.

At a weighted local optimum, all remaining conflict weights increase by the pair's directional
penalty divided by the maximum current penalty. This is the paper's weighting method and makes the
same state cease to be locally optimal under the modified objective. The implementation is a
bounded adaptation rather than the paper's complete no-fit-polygon lower-envelope search:
directional distances use exact collision predicates with binary refinement, and line minima come
from finite geometric events. Balanced repair is capped at 2,000 evaluated moves and 28 pieces;
thorough repair at 8,000 moves and 48 pieces. Variants above 24 vertices stay on the existing
constructive paths to protect curved/compound latency.

Zero overlap is only a repair candidate. The ordinary independent validator reconstructs every
placement and checks quantities, rotations, containment, exclusions, clearances, pair collisions,
and fixed transforms before the incumbent can be replaced. Statistics report attempts, evaluated
and accepted moves, adaptive weight updates, successes, and the best unweighted penalty.

## Feasibility solving

`solve_prepared_feasibility` asks whether at least `k` items can be packed. It returns:

- `feasible`, with an independently validated layout, as soon as the beam reaches the target;
- `impossible_by_bound` when a valid upper bound is below the target;
- `not_found_within_limit` when bounded search ends without a witness.

The last outcome is not evidence of infeasibility. The CLI exposes the same operation as `feasible <problem> <count> [options]`, and the Wasm engine has a thin `feasible` method.

## Warm-started sensitivity

After the first sensitivity point, the nearest evaluated layout becomes a warm start. Each placement is reconstructed against newly prepared geometry and inserted only if it remains valid with the already retained placements. Invalid rotations, quantities, containment, exclusions, and collisions are discarded. The resulting retained or partially repaired state supplies the stronger solver's lower bound; if nothing useful survives, the solve reports `restarted`.

For a repeated single item with positive pair clearance, balanced and thorough ordinary solves also
use a bounded clearance continuation when their direct portfolio leaves a gap. The solver starts
from relaxed separation, raises it through deterministic stages, repairs the prior placement set,
and first attempts to retain the incumbent at every stage. A damaged stage uses a bounded target
beam before a reduced-budget full warm solve; an intact stage performs no portfolio search.
For one independently rotatable elongated compound item, the first improved relaxed layout also
enters a small deterministic annealing portfolio. Its cheap objective replaces each item by a
slightly conservative capsule and keeps containment and exclusions hard. A large axis-aligned
rectangle proven to lie in the container avoids repeated polygon containment work in its interior;
trials outside it use exact containment. Surrogate zero is never sufficient: the ordinary
independent validator must accept the original compound geometry before continuation can stop.
Prepared variants, normalized regions, contacts, and bounds are cloned from one canonical prepared
problem rather than rebuilt. Continuation runs in a container-centred coordinate frame so an
equivalent translation of the entire problem cannot select a different search path; placements
are translated back before validation. The final stage uses the requested clearance, and the
normal independent validator still decides whether the result is accepted. This path recovers the
studio start problem's 21-item layout after two clearance stages; the faster direct lane retains
its 20-item baseline result.

Adaptive midpoint evaluations automatically use `thorough`, concentrating work around observed capacity transitions. Easier and harder changes follow the same validation-first repair path. Non-monotonic capacities remain visible as warnings rather than being rewritten.

## Optional conflict graph

Thorough mode may refine a finite set of at most 96 feasible candidates when the geometric lower/upper gap is at most two. Bounding boxes avoid most edge checks; exact polygon checks create conflict edges, stored as a `u128` bitset. Selection starts with deterministic greedy independent-set construction, then a bounded include/exclude branch-and-bound with quantity and shared-rotation constraints. This bounded search subsumes small swaps.

`best_found`, `limit_reached`, and `candidate_set_optimal` describe the graph search. Candidate-set optimality says nothing about placements absent from the finite contact/grid set and never proves the unrestricted continuous geometric optimum.

## Determinism, limits, progress, and failures

Ordered vectors and maps, total float comparisons, canonical signatures, stable candidate identifiers, and `ChaCha8Rng` seeded only from `SolveOptions.seed` make deterministic runs repeat their selected layout and operation counts. Elapsed time may vary. Deterministic mode rejects wall-clock limits; use iteration/state limits, or opt out of determinism for a native time limit.

Long portfolio, beam, neighbourhood, overlap-repair, and graph loops use bounded budgets and cooperative cancellation. Progress distinguishes baseline, beam, neighbourhood, overlap repair, and refinement phases. Browser cancellation remains immediate by terminating the owning Web Worker, without browser APIs or threading in the core.

Expected failures are finite line events that miss a tight interlock, repair states requiring more than one extra item or the piece/vertex gates, weak bounds on concave or disconnected geometry, high candidate-generation cost in thorough mode, polygon approximation error at low segment counts, and numeric ambiguity near the epsilon. Overlap repair can now cross some barriers that defeat feasible-only insertion, but it is bounded and does not prove a target impossible. All accepted results still pass the independent validator. `BestFound` and `LimitReached` are honest heuristic outcomes, not optimality claims.

The broader audit and its primary-literature mapping are recorded in [solver review and literature map](solver-review.md).
