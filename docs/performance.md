# Performance notes

These numbers are repeatable local observations, not a benchmark suite. `fast` is the retained pre-search greedy path and represents the before baseline; `balanced` and `thorough` show the bounded-search implementation after candidate, state, bound, and graph work was added. Runs used an optimized Rust build on the local Linux development container on 2026-08-04, seed 42, deterministic iteration limits, grid step 0.5, two restarts, and 30,000 base iterations. Each row reports the median of three consecutive CLI runs after compilation.

| Problem | Mode | Count / upper | Time | Generated candidates | Exact checks | Beam states | Graph |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `irregular-rectangles.json` | fast | 18 / 26 | 40 ms | 29,411 | 46,908 | 0 | not run |
| `irregular-rectangles.json` | balanced | 18 / 26 | 93 ms | 298,349 | 55,568 | 236 | not run |
| `irregular-rectangles.json` | thorough | 18 / 26 | 931 ms | 3,554,679 | 304,880 | 4,491 | not run |
| `compound-with-exclusion.json` | fast | 29 / 30 | 497 ms | 29,536 | 56,251 | 0 | not run |
| `compound-with-exclusion.json` | balanced | 29 / 30 | 730 ms | 1,302,706 | 66,080 | 620 | not run |
| `compound-with-exclusion.json` | thorough | 29 / 30 | 3.34 s | 7,965,439 | 282,476 | 3,917 | 96 candidates; limit reached |

Run the same comparison with:

```bash
cargo build --release --workspace
target/release/packing-cli solve examples/irregular-rectangles.json options.json
```

The representative `options.json` is:

```json
{"seed":42,"deterministic":true,"max_iterations":30000,"grid_step":0.5,"restarts":2,"quality":"balanced"}
```

Candidate generation dominates the additional thorough-mode work; exact checks grow much more slowly because bounding boxes and the spatial index reject most remote placements. On these two already lattice-friendly problems, stronger modes match rather than improve the count, so the extra confidence is bounded exploration, not a quality gain. The local remove/repack pass likewise produced only equal-count canonical improvements in these runs. This is useful negative evidence: balanced remains reasonable for ordinary solves, while thorough should be reserved for transitions and small bound gaps.

The deliberately constrained 50-iteration integration case exposes the search-quality difference: on the irregular container, fast finds no complete baseline placement before its limit while balanced retains competing states and returns three independently validated placements. This is not a practical budget recommendation; it is a stable regression case proving that the beam is more than a renamed portfolio pass.

For the balanced rows, broad phase rejected 45,806 and 149,059 remote container/exclusion/item comparisons respectively before exact collision distance work. The corresponding candidate evaluations were 40,232 and 41,670. Exact-check totals also include the mandatory containment test for every evaluated placement, so they should not be read as collision checks alone.

`sensitivity-problem.json` reaches its safe upper bound of six in balanced mode. The root beam state is then pruned by the certified rectangular projection bound, demonstrating that pruning preserves the known feasible solution. Integration tests separately protect deterministic layouts, bounded-mode lower-bound preservation, target feasibility, warm-start validation, and independent final validation.

Millisecond sub-phase timers can read zero for short problems. Candidate, broad-phase, exact-check, state, and prune counts are preferred when comparing algorithm changes. Preparation timing also reads zero for these small inputs; prepared geometry becomes material when a cached Wasm engine repeats solve-only option changes.

## Browser studio default

The literal studio start problem is also protected through the generated Wasm API and the rendered
browser application. These are single observations on the same development container rather than
a cross-device benchmark:

| Implementation | Valid count | Browser wall time |
| --- | ---: | ---: |
| Repeated full continuation solves | 20 | 45.9 s |
| Prepared-state reuse, repair-first stages, and reduced fallbacks | 20 | 29.2 s |
| Tuned two-worker direct/continuation portfolio in Chromium | 20 | 23.1–28.4 s |

Four of the eight continuation stages preserve the incumbent using deterministic local repair in
this case. The other stages try a 512-state target beam and fall back to a three-quarter-budget
warm solve only when necessary. `SolveStatistics` reports repair-only, targeted-search, and full
fallback stage counts. In the browser, `runtime_timing.total_ms` and `phase_ms` use
`performance.now()` in the worker; the Packing diagnostics show those measurements and the active
worker count. Native core timers remain separate and operation counts remain the more reproducible
way to compare machines.

### Exact-fit frontier review (2026-08-05)

The low-complexity exact-fit ranking was measured with the release integration fixtures after
compilation. At the retained Dighe2 balanced budget it raises the independently validated count
from 6 to 7. Applying a 32 × 32 contact frontier indiscriminately was rejected: the capsule fixture
generated 17.1 million candidates and still returned the same count. The accepted complexity gate
uses the detailed frontier only for polygon sets of at most 16 vertices; the same capsule run then
generated 3.08 million candidates and retained its 17-item quality floor.

Three native studio-default runs with the accepted frontier all returned the validated 20-item
continuation witness. Wall times were 17.4 s, 32.3 s, and 17.9 s (17.9 s median), with 1,138,604
bounded-search candidates and 158,891 exact checks in every run. The timing outlier despite
identical operation counts is why operation counts, not a claimed percentage speedup, are the
acceptance signal here. The prior static-frontier/shared-geometry median was about 20.6 s.

### Incumbent contact closure review (2026-08-10)

The screenshot regression exposed an 18-piece learned capsule lattice with two reachable slots,
followed by angle refinement. The portfolio previously inserted before compaction but not after
it, and never tried to complete the best learned lattice before launching the angle portfolio.
A bounded contact-only closure now runs at those phase boundaries, prioritizes already-used and
orthogonal rotations, and immediately rescans a variant after a successful placement.

The native authoritative fixture now reaches the independently validated 20-piece layout during
`baseline` with the 40,000-iteration direct worker budget. Its deterministic ceilings are 450,000
generated candidates and 80,000 exact geometry checks (the measured run used 407,537 and 70,060).
For comparison, the pre-closure 80,000-iteration direct run stopped at 18 with 619,994 generated
candidates and 143,730 exact checks. Thus the regression protects both the earlier solution phase
and an operation-count improvement without relying on machine-dependent wall time. The generated
Wasm runtime test asserts the same phase, count, validation, and ceilings.

### Clearance-aware triangle motifs (2026-08-10)

The latest basic-shape screenshot returned 26 of 50 triangles. The single-orientation lattice
could only stagger identical rotations, the complementary motif path was disabled for every
positive item clearance, and the generic alternating fallback advanced by full triangle bounding
boxes. Increasing iterations therefore searched around a structurally sparse seed.

The motif learner now separates a contact-derived pair to the requested clearance and learns the
repeat pitch from the combined geometry. A deterministic baseline-only regression packs the known
36-piece alternating-row witness for 3 × 3 triangles in a 20 × 15 rectangle with 0.35 pair and
0.3 boundary clearance. It does so at a 10,000-iteration budget; the continuous-rotation web
fixture generated 12,973 candidates and used 4,171 exact checks, with test ceilings of 15,000 and
6,000 respectively. The independent final validator remains the acceptance gate.

Pairwise motif learning is capped at 16 vertices per prepared variant. The default compound
capsule therefore remains on its existing lattice, contact-closure, and continuation paths rather
than paying a continuous-rotation motif cross-product. After adding the gate, the combined release
regression covering the 17-piece width-4.375 case and the 20-piece direct studio witness completed
in 5.44 seconds locally; the direct witness still stays below its 450,000 generated-candidate and
80,000 exact-check ceilings.

### Guided overlap repair (2026-08-10)

The new repair lane starts from the feasible incumbent plus one failed constructive placement,
then allows pair conflicts while alternating bounded horizontal/vertical event searches and
permitted orientations. Directional penetration estimates use exact polygon collision checks and
binary refinement. At local optima, remaining pair weights increase by their penalty divided by
the maximum current conflict, following Umetani et al.'s weighting rule. Container, exclusion,
fixed-placement, quantity, and shared-rotation constraints remain hard; zero penalty is accepted
only after independent validation.

At the retained 20,000-iteration balanced benchmark settings, Dighe2 retains 7 / 10 with one
successful repair in 533 evaluated moves. Dighe1 improves from the previous 10 / 16 floor to
12 / 16; its successful repair occurs within 1,367 evaluated moves. The optimized workspace suite
including both instances and the studio capsule regression completes in 8.31 seconds after
compilation on the development container. Complexity gates skip repair above 28 pieces in balanced
mode (48 thorough) or 24 vertices per variant, preventing the exact directional probes from
collapsing curved/compound latency.

See [the solver review](solver-review.md) for the literature mapping, rejected experiments, and
the recommended overlap-repair/NFP/exact-mode sequence.
