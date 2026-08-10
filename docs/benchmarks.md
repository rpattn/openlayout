# Published benchmark validation

OpenLayout keeps geometric validity and solution quality separate. Every reported layout is
independently revalidated, while a published best-known solution is treated as a target rather
than as proof that this heuristic has attained it.

Small canonical constructions complement the published irregular instances. Automated checks
cover the exact 15-square tiling of a 10 × 6 rectangle, the exact 50-piece complementary
right-triangle tiling of a 10 × 10 square, a 23-disk five-row hexagonal lattice, and a 36-piece
alternating-triangle witness with positive pair and boundary clearance. The last case directly
guards against reducing non-rectangular pieces to their bounding boxes during pattern learning.

## Sources and adaptation

- The [official ESICUP dataset repository](https://github.com/ESICUP/datasets/tree/main/2d_irregular/dighe)
  provides the CC0 Dighe1/Dighe2 XML coordinates and fixed orientation restrictions used here. The associated
  [guided-local-search paper](https://onlinelibrary.wiley.com/doi/10.1111/j.1475-3995.2009.00707.x)
  is Umetani et al. (2009).
- The [two-level collision-free-region study](https://www.scitepress.org/Papers/2011/35219/35219.pdf)
  reports 100% density for both `Dighe1` and `Dighe2`, supplying the ten-piece 100 × 100 target
  used by the check.
- [PackLib²](https://arxiv.org/abs/math/0509176) describes a common XML representation and an
  integrated library of published two-dimensional packing benchmarks and best-known results.
- [A reproducible exact-solution study](https://arxiv.org/abs/2206.00032) explains the numerical
  robustness issues in irregular strip packing and reports independently reproducible optima for
  a benchmark subset.
- [Semi-discrete bottom-left-fill](https://arxiv.org/abs/2103.08739) is a useful recent reference
  for deterministic benchmark protocols over free rotations.

Strip instances are tested as fixed-container feasibility problems: the strip height and a
published target length become a rectangle, and each source piece becomes a quantity-one item with
the source orientation policy. This does not change feasibility at that target length.

## Current checked cases

| Case | Published target | OpenLayout result | What the automated check establishes |
| --- | ---: | ---: | --- |
| ESICUP `Dighe1` | 16 pieces in 100 × 100 (100% density) | 10 / 16 with the retained balanced regression budget | The reflected up-left source coordinates preserve feasibility in OpenLayout's coordinate convention. Input area gives a safe upper bound of 16; all transforms pass independent validation. |
| ESICUP `Dighe2` | 10 pieces in 100 × 100 (100% density) | 7 / 10 with the retained balanced regression budget | Input area gives a safe upper bound of 10; every returned transform passes independent containment and pair-overlap validation. The three-piece quality gap remains explicit. |
| Studio start problem | 20-capsule regression target | 20 / 20 in the 40,000-iteration direct lane | Contact closure completes the learned lattice during baseline, before angle refinement; the ordinary final validator accepts it at the full item, boundary, and exclusion clearances. Clearance continuation independently retains the same floor. |

Neither Dighe case is labelled solved by OpenLayout. Reaching every requested piece would prove
optimality because each set exactly consumes its 100 × 100 target. The current partial results are
solver-quality benchmarks, not geometry-correctness failures. The integration tests retain the
published bounds, measured quality floors, and independent validation, so future search
improvements can close the gaps without silently moving either target.

## Reproduction

Run the native suite for both embedded Dighe coordinate sets:

```sh
cargo test -p packing-core published_dighe
```

The studio start case uses seed 7, balanced quality, grid step 0.5, and three restarts. The direct
worker regression uses 40,000 iterations, while the full continuation lane retains the 80,000 base
budget. Its 20-item result is deterministic; it is a feasible witness, not a proof that 20 is
globally maximal, because the safe unrestricted area bound is higher.
