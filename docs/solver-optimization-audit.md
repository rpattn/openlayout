# Solver optimization and research audit

This is the working evidence log for improving solution quality per unit time. It complements the
architecture and historical performance notes: proposed work belongs here only when it has a
hypothesis, representative cases, and an acceptance gate. A faster weak fixture or a stronger slow
fixture is not enough.

## Acceptance protocol

Every solver change is evaluated on all of these classes:

| Class | Current representative | Quality invariant |
| --- | --- | --- |
| Exact regular tilings | 2 × 2 rectangles, complementary triangles | Retain the proven 15- and 50-piece layouts |
| Curved repeated shapes | unit disks, studio compound capsules | Retain 23 disks, direct 20 capsules, and continuation 21 |
| Positive clearance | alternating 3 × 3 triangles | Retain at least 36 with independent validation |
| Concave/excluded regions | `irregular-rectangles`, `compound-with-exclusion` | Do not reduce the retained counts or violate clearance |
| Published irregular sets | ESICUP Dighe1 and Dighe2 | Retain at least 12/16 and 7/10 at the fixed budget |
| High-vertex irregular set | ESICUP Gardeyn0 conversion | Retain 10/50 and the 1,250-generated/228-exact fast signature |
| Mixed domain behavior | fixed placements, shared angles, disconnected regions | Retain all workflow invariants and deterministic layouts |

Deterministic operation counts are the primary speed gate. Release wall time is reported as a
distribution after warm-up because single timings in this environment vary substantially. Native
and generated-Wasm tests must both pass. The reusable options in
`examples/benchmark-options.json` match the historical 30,000-iteration comparison.

Run repeated prepared solves with deterministic reproducibility checks using:

```bash
cargo run --release -p packing-cli -- benchmark \
  examples/irregular-rectangles.json examples/benchmark-options.json 5
```

The report includes preparation wall time, min/median/max solve wall time, every count/status,
operation counters, and layout identity. A deterministic run fails if either its layout or its
generated/exact/state/iteration signature changes between repeats.

## Hot-path review (2026-08-12)

| Priority | Path | Evidence | Action |
| --- | --- | --- | --- |
| P0 | Dynamic beam contacts | Each state walks every placed polygon, rebuilds vertex/midpoint samples, and allocates temporary vectors although placements only translate prepared variants. | A local-point cache trial was rejected: recomputing transformed midpoints changed floating-point event coordinates and perturbed 13 exact-check decisions. Next test must cache contact descriptors and reproduce the existing arithmetic exactly. |
| P0 | Candidate ordering | Dynamic positions and complete candidate arrays are sorted twice per state. Thorough examples historically generate 3.5–8.0 million candidates. | An unstable-sort trial was rejected because it perturbed exact-check ordering despite retaining the layout. Next experiment: represent static candidates immutably and score lightweight state-local references instead of cloning them. |
| P0 | Spatial lookup | Every evaluated candidate allocated a `BTreeSet` to deduplicate indices returned by grid cells. | Implemented: a placement-sized visitation bitmap plus a final unstable integer sort preserves the exact old index order. |
| P0 | Benchmark breadth | The pinned CC0 Gardeyn0 conversion adds five polygon types, 50 demanded pieces, four discrete orientations, and contours up to 160 vertices. The corpus still lacks free-rotation and mixed-clearance research instances. | Continue importing licensed cases spanning convex/concave, identical/mixed, free rotation, and clearance. Record fixture provenance and best-known target. |
| P1 | Candidate scoring | Alignment scoring scans all placed items for every generated candidate: O(candidates × placed). | Test sorted coordinate indexes with exact epsilon range queries. Accept only if candidate scores and layouts remain byte-for-byte deterministic. |
| P1 | Contact completeness | Vertex/midpoint coincidences are a sampled collision-free-region proxy and miss edge events and narrow tangencies. | Add cached inner-fit/no-fit boundaries first for fixed, low-complexity polygon variants. Keep existing exact validation as the acceptance boundary. |
| P1 | Repair neighbourhood | Guided repair adds only one item and uses a bounded line-event neighbourhood. | Test destroy/reinsert sizes 2, 4, and adaptive conflict components; seed subproblems from residual free-space partitions. Gate by size/complexity and compare success per exact check. |
| P1 | Bounds | Area and rectangular projection are loose on non-convex/curved scenes. | Test convex-decomposition projection bounds and region/clearance-aware dual bounds. Every new bound needs adversarial safety tests before pruning. |
| P2 | Exact small cases | Wider heuristic search cannot prove most irregular targets. | Build a separate fixed-orientation feasibility backend using vertical slices and lazy NFP feasibility cuts; never label a heuristic timeout infeasible. |
| P2 | Pair predicates | Collision and distance repeatedly walk polygon pairs; overlap repair is quadratic in pieces. | Profile cached edge bounds/BVH and NFP directional events by shape-pair/rotation key. Do not add a geometry cache keyed by floating translations (already measured and rejected). |

## Literature gaps and testable avenues

The existing guided local search follows Umetani et al., but several complementary recent results
are not represented:

- Gardeyn, Vanden Berghe, and Wauters' 2025 [Sparrow](https://arxiv.org/abs/2509.13329)
  decomposes nesting into a sequence of feasibility targets and repeatedly resolves temporary
  collisions. Its open-source implementation also separates exploration from compression and
  exposes native SIMD and Wasm variants. OpenLayout's repair lane had the same basic collision
  weighting but discarded its remaining budget after the first +1 success. Thorough mode now
  reinvests that exact remaining move budget in successive validated counts (up to four gains),
  while balanced mode retains its first-success latency contract.
- Sparrow builds on the [jagua-rs collision detection engine](https://github.com/JeroenGar/jagua-rs),
  which combines spatial hazard indexing, polygon simplification guarded by the exact original,
  and fail-fast surrogate poles/piers. This is stronger evidence for benchmarking a dedicated
  broad-phase/BVH or CDE integration than for immediately implementing every NFP special case.
  Jagua's MPL-2.0 licensing and semantic fit for holes, continuous rotation, separation, and Wasm
  should be evaluated in a contained predicate benchmark before any dependency decision.

- The [CG:SHOP 2024 general heuristic](https://doi.org/10.4230/LIPIcs.SoCG.2024.86) partitions
  container/polygon sets into smaller subproblems, then combines sequential construction with
  overlap elimination, differential evolution, local search, and tabu search. The most relevant
  near-term experiment is conflict-component or spatial-region decomposition around a stalled
  incumbent—not a wholesale differential-evolution rewrite.
- The [CG:SHOP best-fit/GA/ILP study](https://doi.org/10.4230/LIPIcs.SoCG.2024.83) dispatches by
  instance size and includes a dedicated rectilinear path. OpenLayout already specializes safe
  bounds but not the search family. A measured shape/instance classifier could route tiny
  fixed-orientation problems to exact search, rectilinear problems to interval/grid methods, and
  general continuous problems to the current portfolio.
- The [maximum polygon packing challenge overview](https://arxiv.org/abs/2403.16203) supplies a
  broader maximum-subset benchmark family. Its convex-container, no-rotation scope is narrower
  than OpenLayout, which makes it a useful controlled test of candidate and repair quality.
- The [vertical-slice reproducibility study](https://arxiv.org/abs/2206.00032) and
  [NFP covering model with vertical slices and feasibility cuts](https://doi.org/10.1016/j.ejor.2023.08.009)
  remain the strongest match for a proof-producing small-instance backend and robust numerical
  regression protocol.
- NFPs remain an engineering project, not a checkbox. The first supported domain should be simple
  low-vertex polygons with fixed discrete rotations and zero/explicit polygonal offsets. Holes,
  disconnected compounds, approximated curves, and arbitrary clearance must remain on exact
  predicates until equivalence is proven.

The June 2026 [geometry-aware reinforcement-learning preprint](https://arxiv.org/abs/2606.10611)
is now a credible research branch: its polygon transformer and cross-polygon attention are reported
competitive with Sparrow and come with a geographic-contour training/evaluation set. It does not
yet justify putting a model in the interactive solver: the preprint is under review, its objective
and data distribution must be mapped to OpenLayout's maximum-count, clearance, compound, and
exclusion cases, and this repository still lacks a large pinned generalization corpus. Near-term ML
work should therefore reproduce/evaluate the released policy as a portfolio proposal generator;
exact predicates and independent validation remain authoritative, and the deterministic geometric
baseline must not be replaced.

## Browser execution review

The persistent 2–4 Web Worker portfolio keeps the UI responsive but duplicates Wasm memory and
prepared geometry. The current improvement gives auxiliary seed workers quiet direct/continuation
exports, eliminating intermediate placement serialization and Wasm-to-JavaScript callbacks while
preserving their budgets and final-result ordering. Primary direct and continuation lanes still
stream visible progress.

Further web work should be measured in this order:

1. Record per-lane completion time, winning frequency, callback count/bytes, peak memory, and cold
   Wasm initialization time in Playwright. Drop or shorten a lane only when its marginal win rate is
   below its wall-time/memory cost across the corpus.
2. Send one canonical problem/options JSON string to workers instead of structured-cloning the
   object and stringifying it separately in every worker. Measure on large compound scenes; small
   examples will not expose the difference.
3. Try SIMD only with a predicate microbenchmark and complete corpus A/B run. Wasm 2.0 includes
   128-bit SIMD and current engines broadly support fixed-width SIMD, but branch-heavy polygon
   predicates may not vectorize profitably ([WebAssembly 2.0 summary](https://webassembly.org/news/2025-03-20-wasm-2.0/),
   [feature matrix](https://webassembly.org/features/)).
4. Shared-memory Wasm threads require `SharedArrayBuffer` and cross-origin isolation, and the
   wasm-bindgen guide notes that long-running worker code must yield before receiving events.
   Evaluate them only after per-worker prepared-memory measurements justify the deployment and
   cancellation complexity ([MDN threads model](https://developer.mozilla.org/en-US/docs/WebAssembly/Understanding_the_text_format#webassembly_threads),
   [wasm-bindgen threading caveats](https://rustwasm.github.io/docs/wasm-bindgen/examples/raytrace.html)).

## Experiment ledger

| Date | Experiment | Result | Decision |
| --- | --- | --- | --- |
| 2026-08-12 | Remove per-state boundary/cell-key vector copies and replace spatial tree dedup with stack/fallback bitmaps | Three warm release runs against an isolated build of `HEAD` retained identical layouts and identical generated/exact/broad-phase/state counts. Median solver time changed from 730 to 423 ms on `irregular-rectangles` (42% lower) and 1,479 to 929 ms on `compound-with-exclusion` (37% lower). Local contact caching and unstable-sort sub-trials retained layouts but changed 13 exact/broad-phase checks, so both were removed. | Accepted; retain exact operation-count equality and the full native/Wasm gates. |
| 2026-08-12 | Quiet progress for auxiliary browser workers | Core budgets and final JSON are unchanged; a generated-Wasm test compares quiet and streaming direct layouts. | Keep pending browser build/runtime gates and callback instrumentation. |
| 2026-08-12 | Sparrow-style sequential feasibility repair | Balanced keeps one gain and its Dighe move ceilings. Thorough can reuse only the remainder of its existing global move budget for up to four validated gains; a deterministic unit fixture proves three gains within the unchanged 512-move minimum budget. | Retain pending a broader benchmark corpus; compare successful gains per exact check before expanding the thorough complexity gates. |
| 2026-08-12 | Centralize overlap/clearance predicates | At zero clearance, the old expression performed an all-edge-pairs distance pass after proving non-overlap, although non-negative distance made rejection impossible. Positive-clearance calls also repeated the overlap walk inside `set_distance`. `sets_conflict` now performs one overlap walk and evaluates distance only when it can affect the result; unit cases cover overlap and both sides of a positive gap. | Accepted as an exact hot-path reduction. Retain the Gardeyn deterministic operation signature and full native/Wasm validation gates. |
| 2026-08-12 | Pin CC0 Gardeyn0 research fixture | Mechanical conversion retains five types, 50 demanded items, four orientations, and contours up to 160 vertices. The fast smoke profile returns 10 valid items with a deterministic 1,250-generated/228-exact signature; the published Sparrow container fits all 50. | Keep the 10-item signature as a regression floor and use the 50-item witness as the quality target, not as an optimality proof. |
| 2026-08-12 | Add per-segment AABB rejection inside exact overlap/distance loops | A seven-run isolated Gardeyn0 comparison retained the identical layout and operation signature, but the warm median increased from 72.29 to 78.13 ms. The extra scalar min/max work outweighed avoided orientation tests on this representative. | Rejected and removed. Test cached edge bounds or a hierarchical index instead of recomputing bounds in the inner pair loop. |
| 2026-08-13 | Prepared per-variant edge BVHs | Edge bounds and an eight-edge binary hierarchy are built once for the container, exclusions, and rotated variants; translation shares the immutable tree plus an offset. Indexed and fallback predicates agree across overlap and positive-clearance cases. Gardeyn0 retained the 10-item/1,250-generated/228-exact signature while its nine-run fast median changed from 72.29 to 67.17 ms (7% lower). | Accepted for edge-pair products of at least 256; small polygons retain the direct loop. |
| 2026-08-13 | Static candidate references and size-dispatched alignment index | Beam states now sort compact origin/score records and resolve immutable static candidates only at evaluation; the redundant pre-score state sort was removed because dedup makes its ID tie-break unreachable. Alignment uses direct scans through 24 placements and sorted epsilon ranges above that boundary. Gardeyn0 retained its exact layout and operation signature; a warm nine-run balanced median was 700 ms with candidate generation around 329 ms, versus 730 ms and around 357 ms before removing the redundant state sort. | Accepted; candidate scoring remains the next dominant search cost. |
| 2026-08-13 | Conflict-component destroy/reinsert | Thorough mode selects the highest-penalty movable component, removes two pieces for larger states or up to four for small states, and sequentially reinserts it inside the same global move budget. Dedicated counters expose attempts/successes; a joint four-piece overlap fixture proves a penalty reduction within 512 moves. Balanced behavior and Dighe ceilings remain unchanged. | Accepted behind Thorough dispatch; collect success per exact check on larger corpus runs before expanding it. |
| 2026-08-13 | Fixed-rotation convex NFP proposal events | Thorough search computes the convex hull of pairwise `fixed - moving` vertices for simple convex variants of at most 12 vertices and adds up to 24 exact forbidden-region corners. A rectangle fixture proves the generated NFP corners; every proposal still passes normal exact containment/collision validation. | Accepted as a bounded proposal lane, not an exact feasibility claim. Extend only after quality-per-candidate comparisons. |
| 2026-08-13 | Exact vertical-slice backend | Fixed-orientation rectangles spanning the complete usable container height reduce exactly to one-dimensional horizontal intervals with clearance NFP cuts. The backend sorts the finite requested widths, returns a validated witness, and records a certified upper bound; a mixed-width fixture tightens the area upper bound from five to two and returns `proven_optimal`. | Accepted as the first deliberately narrow proof domain. General vertical-slice/NFP-cut work must preserve equally explicit completeness conditions. |
| 2026-08-13 | Browser portfolio observability and canonical transport | Solve requests stringify the problem once in the client. Workers report cold Wasm initialization, current Wasm memory, request bytes, callback count/bytes, phase and total time, and lane identity; the client returns all lane timings plus cumulative winning frequencies. | Keep; use real-browser corpus runs to tune lane budgets rather than hard-coded intuition. |
| 2026-08-13 | Combined end-to-end audit after all accepted lanes | Three warm release runs retained deterministic layouts and operation signatures. `irregular-rectangles` now has a 330 ms median with 18 valid items, versus 423 ms after the first hot-path pass and 730 ms at isolated `HEAD`. `compound-with-exclusion` now has a 648 ms median with 29 valid items, versus 929 ms after the first pass and 1,479 ms at `HEAD`. | Accepted: the complete series is about 55–56% faster than the isolated original baseline on these representatives, with no retained quality loss. |
| 2026-08-16 | Component-local scan phases, motif selection, and continuation | The supplied three-component compound-triangle case previously packed 26 items (7/9/10 top-to-bottom) and performed about 256,000 exact checks. Component-local row/grid origins recover 32 direct placements with about 50,000 exact checks. Dimension-aware motif selection retains a useful diagonal discrete-rotation pairing, and capped per-component clearance continuation reaches the required 10/11/13 distribution (34 total) at the studio's 80,000-iteration profile while preserving stronger direct component seeds. | Accepted with the original scene pinned as `multi-container-phase-regression.json`; retain both the quick direct performance gate and exact studio-profile component counts alongside the single-container corpus. |

## Next experiments

1. Add revision and native peak-RSS fields to the benchmark report; prepared repeats, phase times,
   deterministic operation/layout checks, and JSON output are implemented.
2. Run the new browser lane telemetry under Playwright across the studio and compound corpus, then
   tune worker budgets from marginal win rate and memory cost.
3. Extend exact slices from the proven full-height rectangle domain to fixed convex polygons using
   explicit vertical decomposition and lazy NFP feasibility cuts.
4. Cache dynamic contact descriptors without changing floating arithmetic, and replace the
   remaining full candidate score sort with a bounded selection/frontier algorithm.
