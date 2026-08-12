# Frontend audit

This document records the structural audit of `web/src` and the refactoring direction. It is a living checklist: an item is only marked complete when the old implementation has been removed and the production build and relevant browser coverage pass.

## Current architecture

| Area | Current module | Responsibility | Audit status |
| --- | --- | --- | --- |
| Application composition | `main.ts` | Startup, feature wiring, editor commands, project/solve orchestration | Composition hotspot; shell, inspectors, dialogs, sidebars, sensitivity markup/domain, exports, and reusable toolbar behavior extracted |
| CAD scene | `cad-workspace.ts` | SVG scene composition, viewport, selection, pointer gestures, snapping, collision guards | Controller hotspot; geometry, hit testing, drafting/trace rendering, grids, dimensions, and interaction types extracted |
| Domain conversion | `problem.ts` | Editor defaults, schema conversion, primitive geometry, snapping dependencies | Cohesive overall; geometry and parameter mutation should become submodules |
| Persistence | `workspace-store.ts` | Local storage, IndexedDB durability, migration, undo/redo | Clear public boundary; migration and history can be split later |
| Solve runtime | `solver-client.ts`, `solver.worker.ts`, `worker-protocol.ts` | Worker pool and typed messages | Good boundary; lifecycle tests are more important than further splitting |
| Output rendering | `renderer.ts` | Layout, sensitivity, and preview canvas drawing | Manageable after shared geometry extraction; chart rendering can become separate |
| Export | `export-service.ts` | SVG/CSV serialization and browser downloads | Extracted; pure serializers are now independently testable |
| Sensitivity model | `sensitivity-model.ts` | Parameter catalog, schema paths, current values, preview mutation, sample values | Extracted; all operations receive explicit state |
| CAD geometry | `cad-geometry.ts`, `cad-dimensions.ts` | Shape transforms, paths, bounds, collision helpers, grid and dimension SVG | Extracted from the workspace controller |
| CAD drafting scene | `cad-drafting-markup.ts` | Pure trace, guide, drafting, text, and placement-preview SVG | Extracted; receives state and selection predicates explicitly |
| Reusable UI | `toolbar-palette.ts`, `shortcuts.ts` | Accessible palette lifecycle and shortcut reference markup | Extracted from application composition |
| Feature markup | `studio-shell.ts`, `packing-sidebar.ts`, `inspector-markup.ts`, `sensitivity-markup.ts`, `dialog-markup.ts` | Pure shell and feature-specific DOM templates | Extracted; controller code retains event binding and effects |
| Shared foundations | `cad-selection.ts`, `polygon-utils.ts`, `ui-utils.ts`, `design-tokens.ts` | Selection identity, polygon offsets, safe markup, presentation tokens | Extracted and reused |

## Findings

### 1. Oversized application controller

`main.ts` remains a large composition controller. It binds commands, mutates editor state, coordinates solving, and manages projects, but no longer owns the application shell or the substantial feature templates. The remaining size is primarily effectful workflow wiring and editor commands rather than mixed template/domain code.

Refactoring target:

1. ~~Move static shell and toolbar palette markup into feature modules.~~ Completed in `studio-shell.ts` and `toolbar-palette.ts`.
2. ~~Move selection inspector markup behind a feature boundary.~~ Markup completed in `inspector-markup.ts`; bindings remain in the composition controller because they coordinate history and persistence.
3. ~~Move sensitivity markup and domain mutation into dedicated modules.~~ Completed in `sensitivity-markup.ts` and `sensitivity-model.ts`; solve orchestration remains at the composition root.
4. Keep future workflow additions behind explicit contexts rather than adding new template strings or domain algorithms to `main.ts`.

### 2. CAD controller/rendering coupling

`cad-workspace.ts` still renders SVG strings, interprets pointer events, mutates definitions and placements, evaluates placement feasibility, and owns viewport behavior in one class. Private methods reduce its apparent API but do not reduce internal coupling.

Refactoring target:

1. ~~Extract pure scene geometry and hit-test helpers.~~ Completed in `cad-geometry.ts`.
2. Extract SVG markup for handles and overlays; dimensions/grids are in `cad-dimensions.ts`, while drafting/trace layers are in `cad-drafting-markup.ts`. Selection handles remain next to gesture behavior because both share the same resolved interaction context.
3. ~~Represent pointer interaction as a discriminated interaction state rather than a large optional-field drag record.~~ Completed in `cad-interaction.ts`.
4. Keep `CadWorkspace` as the lifecycle/controller facade used by `main.ts`.

### 3. Duplicated foundations and visual drift

Selection comparison, snap dependency traversal, HTML escaping, numeric formatting, polygon offsets, anchor lists, and item colors had multiple implementations. The renderer and CAD workspace used visibly different item palettes.

Completed:

- `cad-selection.ts` is the canonical selection type and identity comparator.
- `problem.ts` owns snap dependency traversal.
- `polygon-utils.ts` owns contour winding and polygon offsetting.
- `ui-utils.ts` owns safe markup escaping, clamping, and compact number formatting.
- `design-tokens.ts` owns anchors and one shared item palette.

### 4. Mixed pure and effectful export code

Export serialization and temporary DOM/download behavior were embedded in the application controller. They now live in `export-service.ts`; PNG canvas cleanup is guaranteed even when rendering or encoding fails. A follow-up should put the pure serializers under direct unit tests.

### 5. CSS ownership

`style.css` is a single global stylesheet spanning shell, dialogs, inspector controls, CAD overlays, responsiveness, and sensitivity. This makes deletion and feature ownership difficult even though the file is smaller than the TypeScript hotspots.

Completed: `style.css` is now a stable import entry for `foundation`, `sidebar`, `cad`, `dialogs`, `sensitivity`, and `responsive` feature sheets. The unused legacy `.model-*` subsystem was removed after a repository-wide usage scan. The existing custom-property theme contract is unchanged.

### 6. Test shape

The browser suite provides valuable workflow coverage, but most pure frontend behavior has no fast unit-level checks. Add direct coverage for selections, dependency cycles, polygon offsets, serialization escaping, persistence migration, and parameter mutation. Keep end-to-end tests focused on feature wiring and user-visible behavior.

## Completion gates

- No application or CAD module combines shell markup, domain mutation, rendering, and persistence/worker effects.
- Shared concepts have one implementation and one import path.
- Feature modules expose narrow typed interfaces; extracted code does not reach back into mutable globals.
- Legacy implementations and unused CSS are removed after each extraction.
- `npm run build`, Wasm runtime tests, and all Playwright workflows pass.
- Largest-file and duplication audits are rerun after the final refactor, with remaining large files justified by cohesive responsibility rather than tolerated by size alone.

## Final verification

- Production TypeScript and Vite build: passed.
- Wasm runtime test: passed (1/1).
- Playwright workflow suite: passed (26/26).
- `git diff --check`: passed.
- Legacy `.model-*` selector scan: no production or test references; the unused subsystem was removed.
- Duplicate-symbol audit: shared lock resolution, selection narrowing, color validation, status humanization, primitive scaling, bounds, selection identity, dependency traversal, escaping, formatting, polygon offsets, anchors, and palette tokens now have canonical modules. Remaining repeated helper names are local format/field adapters with different feature contracts.
- Final largest modules: `cad-workspace.ts` remains the CAD lifecycle and gesture facade; `main.ts` remains the application composition and effect orchestration root. Their pure geometry, templates, interaction types, feature markup, domain mutation, export serialization, and CSS ownership have moved behind narrow modules. Further splitting either controller would separate sequential workflow state without producing a clearer public boundary.
