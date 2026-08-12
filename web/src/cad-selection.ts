export type CadSelection =
  | { kind: "container"; index: number }
  | { kind: "exclusion"; index: number; partIndex?: number }
  | { kind: "item"; index: number; partIndex?: number }
  | { kind: "guide"; index: number }
  | { kind: "drafting"; index: number }
  | { kind: "text"; index: number }
  | { kind: "dimension"; index: number }
  | { kind: "auto-dimension"; index: number; owner: string; axis: "width" | "height" | "clearance" }
  | { kind: "trace"; index: number }
  | { kind: "placement"; index: number };

export function sameCadSelection(a: CadSelection, b: CadSelection): boolean {
  return a.kind === b.kind
    && a.index === b.index
    && ("partIndex" in a ? a.partIndex : undefined) === ("partIndex" in b ? b.partIndex : undefined)
    && ("owner" in a ? a.owner : undefined) === ("owner" in b ? b.owner : undefined)
    && ("axis" in a ? a.axis : undefined) === ("axis" in b ? b.axis : undefined);
}

export function isPartSelection(value: CadSelection): value is Extract<CadSelection, { kind: "item" | "exclusion" }> {
  return (value.kind === "item" || value.kind === "exclusion") && value.partIndex !== undefined;
}

export function cadLockReference(state: EditorState, selection: CadSelection, placements: readonly Placement[] = []): EditorState["lockedEntities"][number] | null {
  if (selection.kind === "dimension" || selection.kind === "auto-dimension") return null;
  if (selection.kind === "placement") {
    const id = placements[selection.index]?.item_id;
    return id ? { kind: "item", id } : null;
  }
  const id = selection.kind === "container" ? state.containerParts[selection.index]?.id
    : selection.kind === "exclusion" ? state.exclusions[selection.index]?.id
    : selection.kind === "item" ? state.items[selection.index]?.id
    : selection.kind === "guide" ? state.drafting.guides[selection.index]?.id
    : selection.kind === "drafting" ? state.drafting.shapes[selection.index]?.id
    : selection.kind === "text" ? state.drafting.texts[selection.index]?.id
    : state.drafting.traceImages[selection.index]?.id;
  return id ? { kind: selection.kind, id } : null;
}
import type { EditorState, Placement } from "./types";
