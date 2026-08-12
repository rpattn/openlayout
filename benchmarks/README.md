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
