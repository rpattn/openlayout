# Shape modeller

The Shape modeller is the geometry-focused workspace in the browser studio. It edits the same `EditorItem` used by the packing form and serializes constraints into ordinary domain-neutral `ShapePart` data.

## Canvas workflow

Choose an item from the toolbar, then add rectangles, triangles, circles, custom polygons, or closed cubic Bézier paths. The layer list selects overlapping parts. Selected geometry shows its rotated bounding box and nine anchors: center, four edge midpoints, and four corners. Drag a part freely, pull an edge or corner handle to resize it symmetrically, or drag the amber handle to rotate it. Bézier parts expose solid knots and hollow incoming/outgoing tangent handles directly on the canvas. When any shape anchor comes near a compatible anchor on another part, the canvas shows alignment guides and creates a snap on release.

Exact dimensions, rotation, and free coordinates remain editable in the inspector. A constraint can also be configured explicitly by choosing the target, own anchor, target anchor, and numeric offset. “Detach at current position” converts the resolved snapped position back into free coordinates. Dependency choices that would immediately create a cycle are omitted.

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

The lower strip uses the active item parameter, start, end, and step. It renders the two extremes and up to five intermediate geometries immediately, resolving the same dependency relationships. This is a geometry preview rather than a predicted packing result. Running the study still invokes the Wasm solver; each returned evaluation includes its mutated `PackingProblem`, allowing capacity layouts to use the exact geometry shown in the preview.
