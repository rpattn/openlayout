# Architecture

## Data flow

A `PackingProblem` is deserialized into explicit domain-neutral types. `validate_problem` rejects malformed shapes, duplicate identifiers, bad rotations, invalid clearances, unavailable references, and exclusions outside the container. `prepare_problem` then polygonizes primitives, expands permitted rotations, removes variants with equivalent bounds, caches bounding boxes, and computes a safe area-and-quantity upper bound.

`solve_prepared` runs several bounded strategies against that prepared geometry. Each candidate is checked against the container, exclusions, quantities, and already placed items. The best deterministic layout is converted back to ordinary `Placement` values. Crucially, `validate_placements` reconstructs transformed geometry—including compound snap dependencies—from the original definitions and checks every invariant again rather than trusting candidate state. Only a valid layout becomes a `SolveResult`.

Sensitivity analysis clones the input problem, applies one explicit numeric parameter path, resolves compound dependencies during preparation, and solves that case. Sampled mode evaluates a regular series. Adaptive mode repeatedly bisects adjacent samples with different capacities until their interval meets the requested tolerance. An observer reports each completed evaluation and whether it belongs to the initial sweep or adaptive refinement; the worker streams these events to the studio progress bar. Results include the evaluated problem geometry, every solve status, representative layouts by distinct capacity, transition intervals, and warnings for suspicious increases when the parameter is declared harder as it grows. Carrying the evaluated geometry lets the frontend render and select each graph point with its actual dimensions and dependent positions.

## Geometry representation

Geometry is a small internal `PolygonSet`: one polygon for ordinary shapes and one polygon per compound part. Rectangles and triangles are centred on their local origin. Polygon coordinates are used as supplied. Circles become regular polygons with a configurable count between 12 and 4096. Compound transforms are applied before placement transforms.

Serialized coordinates are `f64` in a single caller-defined linear unit. Arbitrary rotations inherently produce non-integral coordinates, so the prototype uses a `1e-7` geometric epsilon instead of misleading exact integer claims. Input polygons are normalized to counter-clockwise winding and checked for zero-length edges, zero area, and self-intersection. Closed cubic Bézier inputs retain their knots and incoming/outgoing controls in the model, then tessellate each span at a caller-selected resolution and pass through the same polygon validation and packing path.

Containment combines point-in-polygon, edge-midpoint, boundary-crossing, and boundary-distance checks. Collision checks use segment crossing, strict containment, coincident-edge interior detection, and minimum segment distance. Cached bounds provide the broad phase. This direct implementation keeps the proof inspectable; robust Boolean kernels and no-fit polygons remain roadmap work.

Compound parts are not unioned. Collision and containment operate over every part, which is correct, while the upper bound uses only the largest component area as a guaranteed occupied-area lower bound. Exclusion areas are not subtracted from that bound because overlapping exclusions could otherwise make the claimed upper bound unsafe.

A compound part may be free or snapped to an earlier or later part. A snap relates one of nine anchors on the dependent part’s local bounding frame to one of nine anchors on the target, plus an explicit offset. Both anchor frames rotate with their shapes, so corners and edge midpoints remain attached to the intended geometry at arbitrary angles. Preparation resolves the dependency graph recursively and rejects missing targets, self-reference, and cycles. Because this happens after parameter mutation and before rotated item preparation, dependent parts follow dimension and rotation changes in native, CLI, and Wasm solves—not only in the editor.

## Clearance convention

Clearance participates in feasibility, never merely scoring. A requested item separation `d` means physical boundaries must be at least `d` apart. Conceptually each item owns half of a symmetric collision envelope (`d / 2`), although the implementation compares the total boundary distance directly and avoids materializing buffers. Physical touching is permitted only when required separation is zero.

Boundary clearance is the minimum item-to-container-boundary distance after containment. Exclusion clearance is `max(problem.item_to_exclusion, exclusion.clearance)`. The solver and independent validator use the same convention through separate data paths.

The layout clearance overlay is explanatory rather than part of feasibility calculation: it draws the container's inward boundary-clearance line, each exclusion's outward effective-clearance line, and half of the item-to-item separation around each placed item. The numeric dimension overlay uses each transformed placement's overall bounds.

## Prepared problem and solver portfolio

`PreparedProblem` owns the validated problem, normalized container and exclusions, item rotation variants, variant indexes by item identifier, cached bounds, and the simple upper bound. This separates geometry work from repeated seeded attempts and sensitivity evaluations.

The portfolio uses structured rows, staggered rows, columns, alternative low/high origins, all prepared rotations, deterministic shuffled restarts, contact/grid greedy insertion, and a bounded directional compaction pass. Candidate scoring is intentionally lexicographic and explicit: feasible candidates are visited from the lower boundary upward and left-to-right, with the layout count as the primary objective and a stable transform key as the tie breaker. More sophisticated scoring belongs after representative cases show which terms matter.

## Validation and result meaning

The validator checks permitted item and rotation references, container containment, boundary clearance, exclusion collision and clearance, pair separation, quantity limits, and exact preservation of fixed transforms. A failed final validation is a typed `Validation` error rather than a successful result with a warning.

`ProvenOptimal` is used only when the count reaches the safe area/quantity upper bound. Most completed searches return `BestFound`; hitting an iteration or time bound returns `LimitReached`, and observer cancellation returns `Cancelled`. `Infeasible` means the portfolio placed nothing, not a mathematical proof of infeasibility. The enum also reserves `Feasible` for workflows that intentionally stop after finding a satisfactory layout.

## Native and Wasm boundaries

`packing-core` contains no browser, JavaScript, command parsing, or `wasm-bindgen` types. The CLI only reads JSON, calls core entry points, and prints JSON. Its `SolveOptions` file demonstrates deterministic iteration-bounded solving, and result timing supports repeatable manual inspection.

`packing-wasm` parses input strings, caches the latest `PreparedProblem`, calls the same core functions, serializes results, and converts typed core failures to JavaScript errors. A progress adapter forwards complete intermediate placement arrays after portfolio attempts. It has no geometry or solving logic. Bare Wasm has no core wall clock, so browser execution is deterministic and iteration-bounded; the owning Web Worker provides immediate cancellation through termination.

The TypeScript studio keeps an editor model for parameterized primitives and converts it into neutral `PackingProblem` shapes. Exclusions become transformed polygons and item parts become compound shapes. A persistent worker owns one `PackingEngine`, so changes to seed or iteration settings reuse prepared geometry when the problem JSON is unchanged. The main thread renders the original shapes plus placement transforms and never performs solver geometry.
