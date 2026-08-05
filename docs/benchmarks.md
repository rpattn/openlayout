# Published benchmark validation

OpenLayout keeps geometric validity and solution quality separate. Every reported layout is
independently revalidated, while a published best-known solution is treated as a target rather
than as proof that this heuristic has attained it.

## Sources and adaptation

- The [ESICUP irregular strip-packing instances](https://sites.google.com/view/umepon/benchmark)
  provide the original polygon coordinates and orientation restrictions used here. The associated
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
| ESICUP `Dighe2` | 10 pieces in 100 × 100 (100% density) | 8 / 10 with expanded thorough search | Input area gives a safe upper bound of 10; every returned transform passes independent containment and pair-overlap validation. The two-piece quality gap remains explicit. |
| Studio start problem | 20 capsules | 20 / 20 with balanced defaults | A deterministic clearance-continuation run returns a 20-item witness, and the ordinary final validator accepts it at the full item, boundary, and exclusion clearances. |

`Dighe2` is intentionally not labelled solved by OpenLayout. Reaching ten would prove optimality
because the pieces exactly consume the 100 × 100 container area; the current eight-piece result is
a solver-quality benchmark, not a geometry-correctness failure. The integration test retains the
published ten-piece bound and refuses invalid output, so future search improvements can close the
gap without silently moving the target.

## Reproduction

Run the native suite for the embedded `Dighe2` coordinates:

```sh
cargo test -p packing-core published_dighe2_target_bounds_and_validates_the_current_result
```

The studio start case uses seed 7, balanced quality, 80,000 base iterations, grid step 0.5, and
three restarts. Its 20-item result is deterministic; it is a feasible witness, not a proof that 20
is globally maximal, because the safe unrestricted area bound is higher.
