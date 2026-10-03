import type { CodeViewItem } from "@pierre/diffs";
import type { ReviewAnnotationPayload } from "./review-annotations";
import { reviewContentRevision } from "./review-anchors";

export function reviewCodeViewVersion(identity: string, active = true): number {
  // A zero-sized retained surface can retire Pierre's native line/slot layout.
  // Its visibility transition must rebuild that layout from the same data.
  const [, high, low] = reviewContentRevision(
    JSON.stringify([identity, active]),
  ).split(":");
  return (parseInt(high!, 36) >>> 11) * 0x1_0000_0000 + parseInt(low!, 36);
}

/** Retain the exact item Pierre prepared when only a sibling's review changed. */
export function retainReviewCodeViewItem(
  retained: Map<string, CodeViewItem<ReviewAnnotationPayload>>,
  item: CodeViewItem<ReviewAnnotationPayload>,
): CodeViewItem<ReviewAnnotationPayload> {
  const previous = retained.get(item.id);
  if (
    previous &&
    previous.type === item.type &&
    previous.version === item.version &&
    previous.collapsed === item.collapsed &&
    previous.annotations === item.annotations &&
    (previous.type === "diff" && item.type === "diff"
      ? previous.fileDiff === item.fileDiff
      : previous.type === "file" &&
        item.type === "file" &&
        previous.file === item.file)
  )
    return previous;
  retained.set(item.id, item);
  return item;
}
