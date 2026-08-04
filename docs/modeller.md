# Shape modeller

The Modeller is the geometry-focused workspace in the browser studio. Its target selector switches between item definitions, every additive/subtractive container part, and every exclusion. Definition-level toolbar actions create and delete all four target classes without returning to Packing. All targets use the same direct manipulation vocabulary and serialize back into the schema-v2 problem model.

## Canvas workflow

Choose a geometry target from the toolbar, then add rectangles, triangles, circles, custom polygons, or closed cubic Bézier paths. The layer list selects overlapping item parts. Selected geometry shows its rotated bounding box and nine anchors: center, four edge midpoints, and four corners. Drag a part freely, pull an edge or corner handle to resize it symmetrically, or drag the amber handle to rotate it. Bézier parts expose solid knots and hollow incoming/outgoing tangent handles directly on the canvas. When any item-shape anchor comes near a compatible anchor on another part, the canvas shows alignment guides and creates a snap on release.

Selecting a container part or exclusion changes the shape buttons from adding compound parts to replacing that shape while preserving its centre and overall dimensions. Container parts can be changed between additive material and subtractive cut-outs in the target settings. Dimension and clearance toggles independently control the annotations; dashed clearance runs inward for additive material and outward around structural cut-outs and exclusions.

Exact dimensions, rotation, and free coordinates remain editable in the inspector. A constraint can also be configured explicitly by choosing the target, own anchor, target anchor, and numeric offset. “Detach at current position” converts the resolved snapped position back into free coordinates. Dependency choices that would immediately create a cycle are omitted.

The definition settings edit item identity, quantity, rotation policy and angle coupling, container identity and Boolean operation, or exclusion identity and clearance. Fixed placements are also created, transformed, reassigned, and deleted here so the Packing workspace remains a read-only view of problem geometry.

Dragging a constrained part preserves the relationship and edits its snap offset. A relationship is removed only with “Detach at current position” or Escape; both preserve the current resolved position instead of allowing the part to jump back to stale fallback coordinates.

Snaps use the shape’s local bounding-frame anchors transformed by its rotation. Rectangle corners and edge midpoints therefore stay on the actual rotated rectangle instead of drifting to the corners of a screen-aligned bounding box. The same oriented-frame rule remains predictable for triangles, Bézier paths, and arbitrary polygons without introducing shape-specific edge naming.

Bézier paths remain closed packing regions. Each cubic span is sampled at the configured segment count and validated as an ordinary non-self-intersecting polygon before solving. This keeps collision and clearance behavior identical to other shapes while the editable source retains smooth curve controls.

## Parameter behavior

A snap is stored by target part index in `PackingProblem`, not as a frontend-only coordinate. During geometry preparation the engine:

1. constructs and rotates each local part;
2. resolves target dependencies;
3. finds both requested local-frame anchors and rotates them with their parts;
4. translates the dependent anchor to the target anchor plus offset;
5. rejects missing targets, self-snaps, or cycles.

Sensitivity mutation happens before this resolution. If circles have their centers snapped to a rectangle’s left and right edge midpoints, changing the rectangle width moves both circle centers to the new edges automatically.

## Sensitivity preview

Sensitivity preview now lives on the dedicated Sensitivity page. It renders the two extremes and up to five intermediate geometries immediately, resolving the same dependency relationships. Item parameters show the changing item definition; container, exclusion, and clearance parameters show the changing field. This is a geometry preview rather than a predicted packing result. Running the study still invokes the Wasm solver; each returned evaluation includes its mutated `PackingProblem`, allowing capacity layouts to use the exact geometry shown in the preview.
