# Solver review and literature map

This review separates three questions that are easy to conflate: whether a returned layout is
geometrically valid, whether the search finds a strong layout quickly, and whether the count is
globally optimal. OpenLayout independently validates every returned layout. It is a bounded
heuristic unless a feasible count reaches a safe unrestricted upper bound; a finite candidate-set
proof is deliberately labelled more narrowly.

## Audit findings

| Area | Finding | Current action | Remaining limitation |
| --- | --- | --- | --- |
| Final correctness | Search geometry is reconstructed by the independent validator. Relaxed continuation previews previously escaped to the UI, although final results remained valid. | Final validation remains mandatory; relaxed previews retain the last full-clearance witness until the final stage. | Floating-point polygon approximation still depends on the input segment resolution and epsilon policy. |
| Prepared geometry | Variants, bounds, contacts, and normalized regions are reused, but every beam-state clone also copied every transformed polygon. | Accepted transformed geometries are shared with `Arc`; state clones copy references. | The browser worker portfolio still keeps one prepared cache per worker. |
| Candidate generation | Container, exclusion, grid, and fixed-placement candidates were regenerated for every state even though they are state-independent. | The root builds a static frontier once; states add only contacts from movable placements and filter exhausted item quantities. | Dynamic contact construction remains quadratic in the selected contact samples. |
| Exact fitting | All item-contact candidates had the same score, so a placement supported by several coincident vertex/edge constructions could be truncated behind an arbitrary single contact. | Low-complexity polygons count duplicate contact constructions and receive a capped multi-contact bonus. Dighe2 improves from 6 to 7 pieces at the retained balanced budget. | This is a sampled proxy for a no-fit/collision-free-region arrangement, not a complete arrangement. |
| Curved and compound items | Increasing every contact set to 32 points caused 17.1 million candidates in the capsule regression and did not improve its count. | Detailed contacts are enabled only for polygon sets with at most 16 vertices; sampled curves and compounds retain an eight-point dynamic frontier. | Uniform sampling can miss a critical curved tangency. |
| Bounds | Area, split-region, and rectangular projection bounds are safe and tested, but the studio area's bound is much larger than its 20-item witness. | Bound provenance and prune counts remain explicit. | General non-convex continuous packing needs stronger relaxation or exact decomposition to prove optimality. |
| Search | Greedy portfolios, bounded beam search, local remove/repack, continuation, and a small finite conflict graph cover complementary cases. | The validated lower bound is never discarded; candidate/state budgets remain deterministic. | Feasible-only construction cannot cross an overlap barrier and can become trapped in a poor combinatorial basin. |
| Browser execution | A two-to-four Web Worker portfolio already runs direct, continuation, and deterministic seed lanes concurrently. | Workers own isolated Wasm engines, keeping the UI responsive without shared-memory requirements. | More workers duplicate prepared data and cannot compensate for weak candidates or bounds. |
| Benchmarking | The studio case protects the 20-item witness; official ESICUP Dighe1 and Dighe2 data provide published exact-density targets. | Dighe1 has a 10/16 floor and Dighe2 a 7/10 floor, both with safe area bounds and independent validation. | Two related puzzle instances are still not enough for broad solver-quality claims. |

The review also rejected a transformed-candidate geometry cache keyed by exact floating-point
translations. It increased lookup/allocation overhead without materially reducing exact checks on
the studio problem. It was removed rather than retained as speculative complexity.

## How the literature maps to the implementation

- Umetani et al.'s [guided local search](https://onlinelibrary.wiley.com/doi/10.1111/j.1475-3995.2009.00707.x)
  minimizes overlap using directional penetration information. OpenLayout currently constructs
  feasible layouts only. An overlap-minimizing repair lane is therefore the highest-value new
  search family: it could traverse temporarily infeasible states and then hand a repaired witness
  to the existing validator.
- Sato, Martins, and Tsuzuki describe [collision-free regions and exact fitting
  placements](https://www.sciencedirect.com/science/article/pii/S0010448512000565). The new
  multi-contact support score is a bounded discrete version of that priority: translations implied
  by several contact pairs enter the beam before single-contact alternatives.
- Burke et al. construct [no-fit polygons for line-and-arc
  geometry](https://pubsonline.informs.org/doi/10.1287/opre.1090.0770). Cached NFP/inner-fit
  boundaries would replace many transform-and-collision probes, but adopting them requires a
  robust convention for holes, disconnected compounds, clearances, and approximated curves.
- Cherri et al.'s [robust mixed-integer formulation](https://www.sciencedirect.com/science/article/pii/S0377221716301370)
  combines direct geometry with convex decomposition and no-fit polygons. This is a credible exact
  path for fixed orientations and small instances, distinct from making the heuristic beam wider.
- Lastra-Díaz and Ortuño's [vertical-slice exact
  method](https://arxiv.org/abs/2206.00032) emphasizes reproducible numerics, while the later
  [vertical-slice and feasibility-cut model](https://www.sciencedirect.com/science/article/pii/S0377221723006148)
  strengthens the formulation iteratively. These methods are the best match for an eventual
  `exact` mode that must prove Dighe-style targets rather than merely search longer.
- [Semi-discrete bottom-left fill](https://arxiv.org/abs/2103.08739) provides a deterministic
  compromise for free rotations. OpenLayout's adaptive-angle variants serve a similar practical
  role, although candidate positions remain contact/grid based.

## Recommended development order

1. Expand the benchmark harness to several ESICUP/PackLib instances and record best-known target,
   orientation policy, count, validity, operation counts, and wall-time distributions.
2. Add a bounded overlap-minimization repair lane using per-pair penetration penalties, seeded from
   failed high-count constructive states. Accept output only after exact repair and validation.
3. Introduce convex decomposition plus cached NFP/inner-fit boundaries for fixed discrete variants.
   Use those boundaries for complete contact-event generation before considering an exact model.
4. Add a separate small-instance exact feasibility backend with vertical slices and lazy
   feasibility cuts. Binary-search target count only when the backend can return a proof.
5. Revisit shared prepared geometry or Wasm threads only after profiling the algorithmic lanes.
   The existing worker portfolio already supplies coarse browser parallelism without deployment
   requirements such as cross-origin isolation.

The immediate next performance gain is therefore algorithmic, not simply more browser threads.
Parallel workers are useful for independent strategies, but stronger contact arrangements,
overlap repair, and bounds reduce the work each worker must do and improve solution quality as well
as latency.
