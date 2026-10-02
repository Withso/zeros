import { useMemo, useRef } from "react";
import { CodeView, PatchDiff, type CodeViewHandle } from "@pierre/diffs/react";
import {
  getSingularPatch,
  type CodeViewItem,
  type SelectedLineRange,
  type FileContents,
} from "@pierre/diffs";
import {
  finishDiffRender,
  zerosCodeViewOptions,
  zerosDiffOptions,
} from "@/renderer/shared/theme/diff-theme";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import {
  reviewContentRevision,
  type ReviewCodeSnapshot,
} from "./review-anchors";
import {
  reviewAnnotationVersion,
  reviewUnplacedThreads,
  type ReviewAnnotationPayload,
} from "./review-annotations";
import {
  retainReviewCodeViewItem,
  reviewCodeViewVersion,
} from "./review-code-view-items";
import { ReviewUnplacedThreads } from "./review-annotation-view";
import { ReviewFeedback } from "./review-feedback";
import { labelReviewGutter, REVIEW_GUTTER_CSS } from "./review-pierre-options";
import { useInlineReview } from "./use-inline-review";
import type { CodeReviewController } from "./use-code-review";
import type { ReviewLiveHunkSource } from "./review-hunk-model";

function diffSnapshot(
  path: string,
  patch: string,
  confirmedRevision?: string,
): Extract<ReviewCodeSnapshot, { kind: "diff" }> | null {
  try {
    return {
      kind: "diff",
      path,
      revision: reviewContentRevision(patch),
      fileDiff: getSingularPatch(patch),
      confirmedRevision,
    };
  } catch {
    return null;
  }
}

export function ReviewDiffView({
  path,
  patch,
  review,
  active,
  diffStyle,
  confirmedRevision,
  onScroller,
  hunkSource,
}: {
  path: string;
  patch: string;
  review: CodeReviewController;
  active: boolean;
  diffStyle: "unified" | "split";
  confirmedRevision?: string;
  onScroller?: (element: HTMLDivElement | null) => void;
  hunkSource?: ReviewLiveHunkSource;
}) {
  const snapshot = useMemo(
    () => diffSnapshot(path, patch, confirmedRevision),
    [path, patch, confirmedRevision],
  );
  if (!snapshot)
    return <p className="text-fg3 p-4 text-xs">No textual diff to show.</p>;
  return (
    <ReviewedCodeView
      snapshot={snapshot}
      review={review}
      active={active}
      diffStyle={diffStyle}
      onScroller={onScroller}
      hunkSource={hunkSource}
    />
  );
}

export function ReviewSourceView({
  path,
  content,
  review,
  active,
  onScroller,
}: {
  path: string;
  content: string;
  review: CodeReviewController;
  active: boolean;
  onScroller?: (element: HTMLDivElement | null) => void;
}) {
  const snapshot = useMemo<Extract<ReviewCodeSnapshot, { kind: "file" }>>(
    () => ({
      kind: "file",
      path,
      content,
      revision: reviewContentRevision(content),
    }),
    [path, content],
  );
  return (
    <ReviewedCodeView
      snapshot={snapshot}
      review={review}
      active={active}
      diffStyle="unified"
      onScroller={onScroller}
    />
  );
}

function ReviewedCodeView({
  snapshot,
  review,
  active,
  diffStyle,
  onScroller,
  hunkSource,
}: {
  snapshot: ReviewCodeSnapshot;
  review: CodeReviewController;
  active: boolean;
  diffStyle: "unified" | "split";
  onScroller?: (element: HTMLDivElement | null) => void;
  hunkSource?: ReviewLiveHunkSource;
}) {
  const view = useRef<CodeViewHandle<ReviewAnnotationPayload, undefined>>(null);
  const inline = useInlineReview(review, active);
  const { annotationsForDiff, annotationsForFile } = inline;
  const theme = useCodeTheme();
  const retained = useMemo(
    () => new Map<string, CodeViewItem<ReviewAnnotationPayload>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prepared native item objects belong to one workspace owner
    [review.ownerKey],
  );
  const file = useMemo<FileContents | undefined>(
    () =>
      snapshot.kind === "file"
        ? {
            name: snapshot.path,
            contents: snapshot.content,
            cacheKey: snapshot.revision,
          }
        : undefined,
    [snapshot],
  );
  const items = useMemo<CodeViewItem<ReviewAnnotationPayload>[]>(() => {
    if (snapshot.kind === "diff") {
      const annotations = annotationsForDiff(
        snapshot.path,
        snapshot,
        hunkSource,
      );
      return [
        retainReviewCodeViewItem(retained, {
          id: snapshot.path,
          type: "diff",
          fileDiff: snapshot.fileDiff,
          annotations,
          version: reviewCodeViewVersion(
            `${snapshot.revision}:${reviewAnnotationVersion(annotations)}`,
            active,
          ),
        }),
      ];
    }
    const annotations = annotationsForFile(snapshot.path, snapshot);
    return [
      retainReviewCodeViewItem(retained, {
        id: snapshot.path,
        type: "file",
        file: file!,
        annotations,
        version: reviewCodeViewVersion(
          `${snapshot.revision}:${reviewAnnotationVersion(annotations)}`,
          active,
        ),
      }),
    ];
  }, [
    snapshot,
    file,
    annotationsForDiff,
    annotationsForFile,
    retained,
    hunkSource,
    active,
  ]);
  const options = useMemo(() => {
    const shared = zerosCodeViewOptions<ReviewAnnotationPayload>({
      diffStyle,
      codeThemeId: theme,
      disableFileHeader: true,
      surface: snapshot.kind === "file" ? "bg1" : "sidebar-bg",
    });
    return {
      ...shared,
      ...inline.options,
      unsafeCSS: `${shared.unsafeCSS ?? ""}\n${REVIEW_GUTTER_CSS}`,
      onPostRender: (node: HTMLElement) => {
        finishDiffRender(node);
        labelReviewGutter(node);
      },
    };
  }, [diffStyle, theme, snapshot.kind, inline.options]);
  const unplaced = useMemo(
    () => reviewUnplacedThreads(snapshot, review.threads),
    [snapshot, review.threads],
  );
  return (
    <div
      data-reviewed-code-view
      className="relative h-full min-h-0 focus-visible:outline-none"
      tabIndex={active ? 0 : -1}
      aria-label="Code review. Press Command or Control Shift M to comment on lines."
      onKeyDown={(event) =>
        inline.onKeyDown(event, snapshot.path, (selection) =>
          view.current?.setSelectedLines(selection),
        )
      }
    >
      <CodeView
        ref={view}
        items={items}
        options={options}
        containerRef={onScroller}
        renderAnnotation={inline.renderAnnotation}
        renderCodeViewFooter={() => (
          <>
            {inline.issue && (
              <p role="status" className="text-fg3 px-3 py-2 font-sans text-xs">
                {inline.issue}
              </p>
            )}
            <ReviewUnplacedThreads
              entries={unplaced}
              review={review}
              active={active}
            />
            <ReviewFeedback review={review} />
          </>
        )}
        className="relative h-full min-h-0 overflow-x-hidden overflow-y-auto"
      />
    </div>
  );
}

/** Review's existing stacked cards retain their content-visibility boundary;
 * the native single-file renderer adds no second scroll surface/virtualizer. */
export function ReviewPatchDiff({
  path,
  patch,
  review,
  active,
  diffStyle = "unified",
  confirmedRevision,
}: {
  path: string;
  patch: string;
  review: CodeReviewController;
  active: boolean;
  diffStyle?: "unified" | "split";
  confirmedRevision?: string;
}) {
  const snapshot = useMemo(
    () => diffSnapshot(path, patch, confirmedRevision),
    [path, patch, confirmedRevision],
  );
  if (!snapshot)
    return <p className="text-fg3 p-4 text-xs">No textual diff to show.</p>;
  return (
    <ReviewedPatch
      snapshot={snapshot}
      patch={patch}
      review={review}
      active={active}
      diffStyle={diffStyle}
    />
  );
}

function ReviewedPatch({
  snapshot,
  patch,
  review,
  active,
  diffStyle,
}: {
  snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }>;
  patch: string;
  review: CodeReviewController;
  active: boolean;
  diffStyle: "unified" | "split";
}) {
  const inline = useInlineReview(review, active);
  const { select } = inline;
  const theme = useCodeTheme();
  const annotations = inline.annotationsForDiff(snapshot.path, snapshot);
  const options = useMemo(() => {
    const shared = zerosDiffOptions({
      codeThemeId: theme,
      disableFileHeader: true,
      diffStyle,
    });
    return {
      ...shared,
      enableLineSelection: active,
      enableGutterUtility: active,
      lineHoverHighlight: "both" as const,
      onLineSelected: (range: SelectedLineRange | null) =>
        select(snapshot.path, range),
      onGutterUtilityClick: (range: SelectedLineRange) =>
        select(snapshot.path, range, "composer"),
      unsafeCSS: `${shared.unsafeCSS}\n${REVIEW_GUTTER_CSS}`,
      onPostRender: (node: HTMLElement) => {
        finishDiffRender(node);
        labelReviewGutter(node);
      },
    };
  }, [active, diffStyle, theme, select, snapshot.path]);
  const unplaced = useMemo(
    () => reviewUnplacedThreads(snapshot, review.threads),
    [snapshot, review.threads],
  );
  return (
    <div
      tabIndex={active ? 0 : -1}
      className="focus-visible:outline-none"
      aria-label={`Review ${snapshot.path}`}
      onKeyDown={(event) => inline.onKeyDown(event, snapshot.path)}
    >
      <PatchDiff
        patch={patch}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={inline.renderAnnotation}
      />
      {inline.issue && (
        <p role="status" className="text-fg3 px-3 py-2 text-xs">
          {inline.issue}
        </p>
      )}
      <ReviewUnplacedThreads
        entries={unplaced}
        review={review}
        active={active}
      />
    </div>
  );
}
