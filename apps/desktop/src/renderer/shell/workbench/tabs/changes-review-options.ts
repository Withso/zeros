import type { SelectedLineRange } from "@pierre/diffs";

interface ItemContext {
  item: { type: string };
}

interface ReviewSelectionOptions {
  onLineSelected(range: SelectedLineRange | null, context: ItemContext): void;
  onGutterUtilityClick(range: SelectedLineRange, context: ItemContext): void;
}

/** Changes' file items are conflict cards and placeholders. They have no
 * review snapshot, so their line numbers open no composer. */
export function changesReviewOptions<O extends ReviewSelectionOptions>(options: O): O {
  return {
    ...options,
    onLineSelected(range: SelectedLineRange | null, context: ItemContext) {
      if (context.item.type !== "file") options.onLineSelected(range, context);
    },
    onGutterUtilityClick(range: SelectedLineRange, context: ItemContext) {
      if (context.item.type !== "file") options.onGutterUtilityClick(range, context);
    },
  };
}
