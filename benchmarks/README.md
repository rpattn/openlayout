# Solver benchmark corpus

These fixtures are pinned research inputs, separate from the small explanatory examples. Every
fixture must record its upstream source, license, transformation, target meaning, and retained
acceptance floor in `docs/benchmarks.md`.

`gardeyn0-90.json` is mechanically converted from the CC0 ESICUP `gardeyn0.json` instance. It uses
the 48,681.08 × 20,000 container in Sparrow's published best-known SVG record and retains the
source demands and 0/90/180/270-degree orientation policy. Regenerate it with:

```bash
cargo run --release -p packing-cli -- convert-jagua-strip \
  path/to/ESICUP/datasets/2d_irregular/gardeyn/gardeyn0.json 48681.08 \
  > benchmarks/gardeyn0-90.json
```

Upstream dataset: <https://github.com/ESICUP/datasets/tree/main/2d_irregular/gardeyn>

Best-known record: <https://github.com/JeroenGar/sparrow/blob/main/data/records/final_best_gardeyn0.svg>

Upstream license: CC0-1.0.

Use `research-fast-options.json` for the stable 1,250-candidate smoke/regression run and
`research-balanced-options.json` for a bounded search-and-repair comparison. The retained fast
floor is 10 valid pieces with 228 exact-geometry checks. Sparrow's record fits all 50 demanded
pieces; that is a research target, not a claim that the target strip length is globally optimal.

`gardeyn0-continuous.json` is the corresponding official `gardeyn0_c.json` conversion: omitted
orientation restrictions become OpenLayout's continuous 0–360-degree policy. It deliberately uses
the same 48,681.08 container, which is feasible as a target because continuous rotation includes
the discrete record's orientations. `gardeyn0-clearance.json` is a documented stress derivative of
the discrete fixture with 25 units of item/item and item/boundary clearance; it is a performance and
correctness regression, not a published best-known target.

`multi-container-phase-regression.json` is the original user-supplied reproduction for disconnected
container performance. The studio's balanced 80,000-iteration profile must place 10, 11, and 13 of
the requested compound triangles in the top, middle, and bottom components respectively. The quick
30,000-iteration performance gate retains 32 placements with fewer than 100,000 exact geometry
checks. This is an OpenLayout regression input rather than an externally published benchmark.
