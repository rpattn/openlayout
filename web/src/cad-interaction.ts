import type { CadSelection } from "./cad-selection";
import type { AnchorName, EditorState, Placement, Point } from "./types";

export interface CadView { minX: number; minY: number; width: number; height: number }

interface InteractionBase {
  startClient: Point;
  startWorld: Point;
  moved: boolean;
}

type DefinitionSelection = Exclude<CadSelection, { kind: "placement" }>;

export type CadInteraction =
  | (InteractionBase & { mode: "pan"; originalView: CadView })
  | (InteractionBase & { mode: "marquee"; currentWorld: Point; additive: boolean; clickSelection?: CadSelection; clickPartIndex?: number })
  | (InteractionBase & { mode: "placement" | "rotate"; placementIndex: number; originalPlacement: Placement; originalPlacements: Placement[] })
  | (InteractionBase & { mode: "group-move" | "group-rotate" | "group-scale"; center: Point; originalState: EditorState; originalPlacements: Placement[] })
  | (InteractionBase & { mode: "anchor-snap"; selection: DefinitionSelection; partIndex: number; ownAnchor: AnchorName; currentWorld: Point; originalState: EditorState })
  | (InteractionBase & { mode: "snap-offset" | "part-move"; selection: DefinitionSelection; partIndex: number; originalState: EditorState })
  | (InteractionBase & { mode: "geometry"; selection: DefinitionSelection; partIndex: number; originalState: EditorState; center: Point; rotation: number; geometryHandle: string })
  | (InteractionBase & { mode: "definition" | "definition-rotate" | "definition-scale"; selection: DefinitionSelection; originalState: EditorState; center: Point })
  | (InteractionBase & { mode: "draft-point"; selection: Extract<CadSelection, { kind: "drafting" }>; partIndex: number; originalState: EditorState })
  | (InteractionBase & { mode: "dimension"; partIndex: number; originalState: EditorState })
  | (InteractionBase & { mode: "auto-dimension"; dimensionOwner: string; originalState: EditorState });

export function isDefinitionInteraction(interaction: CadInteraction): interaction is Extract<CadInteraction, { selection: DefinitionSelection; originalState: EditorState }> {
  return "selection" in interaction && "originalState" in interaction && interaction.mode !== "draft-point";
}

export function isPlacementInteraction(interaction: CadInteraction): interaction is Extract<CadInteraction, { placementIndex: number }> {
  return interaction.mode === "placement" || interaction.mode === "rotate";
}

export function isGroupInteraction(interaction: CadInteraction): interaction is Extract<CadInteraction, { mode: "group-move" | "group-rotate" | "group-scale" }> {
  return interaction.mode === "group-move" || interaction.mode === "group-rotate" || interaction.mode === "group-scale";
}
