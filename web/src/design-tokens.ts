import type { AnchorName, PrimitiveEditor } from "./types";

export const ITEM_COLORS = ["#51c6a4", "#f2b65d", "#7ba4f8", "#d98adf", "#ee716f", "#94c973"] as const;

export const ANCHORS: readonly AnchorName[] = [
  "center", "top", "bottom", "left", "right",
  "top_left", "top_right", "bottom_left", "bottom_right",
];

export function editorColor(part: PrimitiveEditor | null | undefined, fallback: string = ITEM_COLORS[0]): string {
  return part?.color && /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : fallback;
}
