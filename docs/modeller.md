# Shape modeller

The Shape modeller is the geometry-focused workspace in the browser studio. It edits the same `EditorItem` used by the packing form and serializes constraints into ordinary domain-neutral `ShapePart` data.

## Canvas workflow

Choose an item from the toolbar, then add rectangles, triangles, circles, or custom polygons. The layer list selects overlapping parts. Selected geometry shows its rotated bounding box and nine anchors: center, four edge midpoints, and four corners. Drag a part freely, or pull an edge or corner handle to resize it symmetrically. When any of its anchors comes near a compatible anchor on another part, the canvas shows alignment guides and creates a snap on release.

Exact dimensions, rotation, and free coordinates remain editable in the inspector. A constraint can also be configured explicitly by choosing the target, own anchor, target anchor, and numeric offset. “Detach at current position” converts the resolved snapped position back into free coordinates. Dependency choices that would immediately create a cycle are omitted.

Snaps intentionally use rotated bounding-box anchors. For rectangles and circles these coincide with the familiar PowerPoint-style handles. The rule remains predictable for triangles and arbitrary polygons without introducing shape-specific edge naming.

## Parameter behavior

A snap is stored by target part index in `PackingProblem`, not as a frontend-only coordinate. During geometry preparation the engine:

1. constructs and rotates each local part;
2. resolves target dependencies;
3. finds both requested bounding-box anchors;
4. translates the dependent anchor to the target anchor plus offset;
5. rejects missing targets, self-snaps, or cycles.

Sensitivity mutation happens before this resolution. If circles have their centers snapped to a rectangle’s left and right edge midpoints, changing the rectangle width moves both circle centers to the new edges automatically.

## Sensitivity preview

The lower strip uses the active item parameter, start, end, and step. It renders the two extremes and up to five intermediate geometries immediately, resolving the same dependency relationships. This is a geometry preview rather than a predicted packing result. Running the study still invokes the Wasm solver; each returned evaluation includes its mutated `PackingProblem`, allowing capacity layouts to use the exact geometry shown in the preview.
