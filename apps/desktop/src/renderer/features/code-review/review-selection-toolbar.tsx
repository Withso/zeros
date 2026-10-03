import { MessageSquare, X } from "lucide-react";
import { Button } from "@/renderer/shared/ui/primitives";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import { reviewRangeLabel } from "./review-thread-model";

export function ReviewSelectionToolbar({
  anchor,
  active,
  onComment,
  onCancel,
}: {
  anchor: CodeReviewAnchor;
  active: boolean;
  onComment: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-review-selection-toolbar
      role="toolbar"
      aria-label={`Review ${reviewRangeLabel(anchor)}`}
      className="border-border2 bg-bg1 text-fg2 flex w-fit max-w-full items-center gap-2 rounded-md border px-2 py-1 font-sans text-xs"
    >
      <span className="truncate">{reviewRangeLabel(anchor)}</span>
      <Button variant="ghost" disabled={!active} onClick={onComment}>
        <MessageSquare className="size-3" />
        Comment
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6"
        aria-label="Cancel line selection"
        disabled={!active}
        onClick={onCancel}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
