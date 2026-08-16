# Shape editing

Geometry editing is part of the main CAD workspace. There is no editing modal or separate modeller page. The drawing and its contextual inspector cover item definitions, every additive/subtractive container part, every exclusion, fixed placements, and returned solver placements. The object list uses a rendered thumbnail of each definition rather than a generic type icon. All accepted definition edits auto-save locally and resolve into the schema-v2 problem model used for validation and solving.

## Canvas workflow

Select a definition from its rendered thumbnail or by clicking its actual outline in the drawing. For compound items, clicking a visible part also selects that exact part in the inspector. Double-click or use **Focus** to zoom into detailed editing, while **Fit** returns to the complete problem. Drag the outline to move the complete definition, use the top handle to rotate it, and use the corner handle to scale it globally. Global transforms preserve the constraint graph: rotation also rotates snap-offset vectors, while scaling changes every part’s geometry, root position, and snap offset around the geometric centre.

Oriented measurement lines and live width/height labels appear whenever source geometry is selected. Eight grips edit rectangle sides and corners, triangle grips edit its base and height, four circle grips edit radius, polygon grips edit vertices, and Bézier editing includes knots, both tangent controls, and tangent guides. The centre grip moves only the selected source part, allowing it to be positioned or snapped without moving the complete definition. Selection emphasizes the real shape and never adds an enclosing box.

Nine cyan snap handles sit just outside the selected source part so they do not obstruct its geometry grips. Compatible parts expose amber targets at their centres, four edge midpoints, and four corners. Dragging a cyan handle onto an amber target sets the own anchor, target part, target anchor, and a zero offset through the normal construction constraint model. The dashed drag guide is only interaction feedback; the resulting relationship is the same schema relationship shown in the inspector and resolved by the geometry core.

The top toolbar adds rectangles and circles immediately and provides triangle, polygon, and Bézier actions under **More**. The selected context determines whether the new primitive becomes an item, container, or exclusion part. All three construction types use the same target/anchor/offset controls and direct snap behavior. New parts start connected to the selected part’s right-edge midpoint, and all attachment details remain editable. The toolbar and `Delete`/`Backspace` delete the selected part; keyboard deletion is ignored while a text, numeric, or select field has focus. Explicit object buttons remove the entire item, region, or exclusion. Last parts and last objects are not protected: an empty invalid problem remains editable and validation reports its errors.

## Complex material construction

Additive container regions are Boolean-unioned by the packing model, so they remain individually editable while solving as one cohesive material boundary. Select a rectangle, add a circle from the toolbar, and its centre is pinned to the rectangle’s right-edge midpoint—producing a semicircular end once the two additive regions are unioned. **Unify** applies the same relationship to an existing material region. The inspector can change the target and both anchors, and dragging the centre grip near a compatible anchor creates a zero-offset relationship automatically.

Connected material regions behave as one construction for whole-object movement, rotation, and scaling. Root positions and constraint offsets transform together, so an attached end cap does not separate when the construction rotates. The relationship graph is retained in local projects and schema-v2 `RegionPart.snap`, then resolved by the native/Wasm geometry core. Cut-outs retain their subtractive Boolean operation. Items and exclusions use the same compound-part relationship model.

Dimension and constraint toggles independently control problem-wide annotations. Dimensions use one engineering style throughout; selecting geometry no longer adds a second legacy annotation layer. Generated object and clearance dimensions can be selected, dragged to clearer positions, positioned numerically, given text overrides, hidden individually, or reset from the inspector; these edits remain with the project. Automatic dimensions use staggered annotation lanes across material, exclusions, and item samples to reduce label collisions. The dimension tool creates persistent point-to-point dimensions snapped to visible geometry, with editable endpoints, offsets, and optional text overrides in the inspector. Text size, precision, units, and edge thickness come from the shared view settings.

Visible solids and dashed boundaries come from the core's Boolean-resolved contours: joined source parts have no internal seam, holes use the final unified boundary, container clearance runs into usable material, exclusion clearance runs outward, and item-to-item clearance is split equally around editable and packed item silhouettes. Layout PNG exports include whichever dimension and clearance overlays are active. Scene PNG uses the same fitted bounds as the workspace fit-view control and includes the complete visible scene, including drafting content and annotations.

The drafting toolbar can also add multiline scene text. Text content, position, size, rotation, colour, font family, alignment, bold, italic, and underline are editable in the inspector; on-canvas move, resize, and rotation handles behave like trace-image controls. Closed drafting shapes can be shaded with an inspector-selected colour. New text and dragged text or dimensions snap to the configured grid, while holding Alt temporarily bypasses snapping; numeric inspector values remain explicit overrides. Text is stored with the project, included by fit-to-view, and preserved in Scene PNG exports.

Smart snapping treats visible geometry points as independent horizontal and vertical alignment references, including points that sit off the unit grid. The unused axis continues to follow the grid, so successive shapes and drafting segments can stay square with an arbitrary snapped corner. Two-point drafting lines show their live engineering length while the second endpoint is being placed.

The canvas context menu adapts to its selection. Alongside focus and delete it exposes applicable actions such as duplicate, lock or unlock, bring to front, send to back, reset rotation, and toggle a solved placement's fixed state; actions that do not apply to the selected entity are omitted.

Exact dimensions, rotation, and free coordinates remain editable in the inspector. Polygon vertices use one `x, y` pair per line and Bézier knots use their JSON source representation. Part constraints expose the target part, own anchor, target anchor, and numeric offset; targets that would create a cycle are omitted. Dependency and offset links are visible on the canvas, and the filled endpoint can be dragged to edit the offset directly. “Detach at current position” converts the resolved position back to free coordinates, while selecting a new target creates a relationship without making the part jump.

The definition settings edit item identity, quantity, rotation policy and angle coupling, container identity and Boolean operation, or exclusion identity and clearance. Fixed placements can be created, transformed, reassigned, and deleted here. After solving, returned placements can also be selected, dragged, rotated, or edited numerically on the main workspace; doing so marks the result as manually changed because the solver validation describes the original returned layout.

Every primitive also has a **Construction** selector and colour input. Construction reassignment moves the selected primitive between container material, any packable shape, and any exclusion while preserving its resolved position; relationships left behind are detached at their resolved coordinates instead of becoming dangling references. Colour is editor-only metadata stored with the local project. Constituent fills remain visible in editable and packed shapes, while the core's unified silhouette supplies the single outer stroke and all feasibility geometry.

Dragging a compound item moves its free root parts, so snapped dependants continue to follow their stored relationships. A relationship is removed explicitly with “Detach at current position.”

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
