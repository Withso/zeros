import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  CodeViewItem,
  CodeViewLineSelection,
  SelectedLineRange,
  DiffLineAnnotation,
  LineAnnotation,
} from "@pierre/diffs";
import { anchorFromSelection, type ReviewCodeSnapshot } from "./review-anchors";
import {
  ReviewAnnotationCache,
  reviewSelectionKey,
  type ReviewAnnotationPayload,
  type ReviewSelectionTarget,
} from "./review-annotations";
import { ReviewAnnotationView } from "./review-annotation-view";
import type { CodeReviewController } from "./use-code-review";
import type { ReviewLiveHunkSource } from "./review-hunk-model";
import {
  canPostReviewSelection,
  postCapturedReview,
} from "./review-public-post";

export function useInlineReview(review: CodeReviewController, active: boolean) {
  const [record, setRecord] = useState<{
    owner: string;
    target: ReviewSelectionTarget | null;
  }>({ owner: review.ownerKey, target: null });
  const [issue, setIssue] = useState<string | null>(null);
  const selection = record.owner === review.ownerKey ? record.target : null;
  // Captured anchors and native payloads have one semantic workspace lifetime.
  const cache = useMemo(
    () => new ReviewAnnotationCache(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the owner deliberately resets this bounded cache
    [review.ownerKey],
  );
  const snapshots = useMemo(
    () => new Map<string, ReviewCodeSnapshot>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- another owner must never reuse captured code snapshots
    [review.ownerKey],
  );
  const native = useRef<{ owner: string; value: CodeViewLineSelection | null }>(
    { owner: review.ownerKey, value: null },
  );
  const latest = useRef({ review, active, selection, snapshots });
  latest.current = { review, active, selection, snapshots };

  const select = useCallback(
    (
      itemId: string,
      range: SelectedLineRange | null,
      mode: ReviewSelectionTarget["mode"] = "selection",
    ) => {
      const current = latest.current;
      if (!current.active) return;
      if (!range) {
        native.current = { owner: current.review.ownerKey, value: null };
        setRecord((old) =>
          old.target?.mode === "composer"
            ? old
            : { owner: current.review.ownerKey, target: null },
        );
        return;
      }
      const snapshot = current.snapshots.get(itemId);
      const anchor = snapshot && anchorFromSelection(snapshot, range);
      native.current = {
        owner: current.review.ownerKey,
        value: { id: itemId, range },
      };
      if (!anchor) {
        setIssue("Select a valid line range on one side of the code.");
        return;
      }
      setIssue(null);
      const target: ReviewSelectionTarget = {
        itemId,
        anchor,
        mode,
        ...(snapshot.kind === "diff" && snapshot.confirmedRevision
          ? { confirmedRevision: snapshot.confirmedRevision }
          : {}),
      };
      if (mode === "composer")
        current.review.drafts.requestFocus(`new:${reviewSelectionKey(target)}`);
      setRecord((old) => {
        const same =
          old.owner === current.review.ownerKey &&
          old.target &&
          reviewSelectionKey(old.target) === reviewSelectionKey(target);
        // Native selection is reconciled when slots change or a retained surface
        // resumes. Reporting that same range is not a new composer/destination
        // intent, and must preserve text entered while a post was pending.
        if (
          same &&
          (old.target!.mode === mode ||
            (old.target!.mode === "composer" && mode === "selection"))
        )
          return old;
        return { owner: current.review.ownerKey, target };
      });
    },
    [],
  );
  const setSelection = useCallback((target: ReviewSelectionTarget) => {
    setRecord({ owner: latest.current.review.ownerKey, target });
  }, []);
  const cancel = useCallback((target: ReviewSelectionTarget) => {
    setRecord((old) =>
      old.target &&
      reviewSelectionKey(old.target) === reviewSelectionKey(target)
        ? { ...old, target: null }
        : old,
    );
    setIssue(null);
  }, []);
  const annotationsForDiff = useCallback(
    (
      itemId: string,
      snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }>,
      hunkSource?: ReviewLiveHunkSource,
    ) => {
      snapshots.set(itemId, snapshot);
      return cache.forDiff(
        snapshot,
        review.threads,
        selection?.itemId === itemId ? selection : undefined,
        hunkSource,
        active,
      );
    },
    [snapshots, cache, review.threads, selection, active],
  );
  const annotationsForFile = useCallback(
    (
      itemId: string,
      snapshot: Extract<ReviewCodeSnapshot, { kind: "file" }>,
    ) => {
      snapshots.set(itemId, snapshot);
      return cache.forFile(
        snapshot,
        review.threads,
        selection?.itemId === itemId ? selection : undefined,
        active,
      );
    },
    [snapshots, cache, review.threads, selection, active],
  );

  const renderAnnotation = useCallback(
    (
      annotation:
        | LineAnnotation<ReviewAnnotationPayload>
        | DiffLineAnnotation<ReviewAnnotationPayload>,
    ) => {
      const target = annotation.metadata.selection;
      const current = latest.current;
      const snapshot = target && current.snapshots.get(target.itemId);
      const adapter = current.review.external;
      const canPost =
        target && canPostReviewSelection(target, snapshot, adapter);
      return (
        <ReviewAnnotationView
          payload={annotation.metadata}
          review={current.review}
          active={current.active}
          onSelect={setSelection}
          onCancel={cancel}
          postComment={
            canPost
              ? async (captured, body) => {
                  const live = latest.current;
                  const now = live.snapshots.get(captured.itemId);
                  await postCapturedReview(
                    captured,
                    now,
                    live.review.external,
                    body,
                  );
                }
              : undefined
          }
        />
      );
    },
    // Native portals reconcile controls on controller/active transitions even
    // when their immutable annotation payload is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback identity publishes the current control state to retained native slots
    [review, active, setSelection, cancel],
  );
  const onLineSelected = useCallback(
    (
      range: SelectedLineRange | null,
      context: { item: CodeViewItem<ReviewAnnotationPayload> },
    ) => {
      select(context.item.id, range);
    },
    [select],
  );
  const onGutterUtilityClick = useCallback(
    (
      range: SelectedLineRange,
      context: { item: CodeViewItem<ReviewAnnotationPayload> },
    ) => {
      select(context.item.id, range, "composer");
    },
    [select],
  );
  const options = useMemo(
    () => ({
      enableLineSelection: active,
      enableGutterUtility: active,
      lineHoverHighlight: "both" as const,
      onLineSelected,
      onGutterUtilityClick,
    }),
    [active, onLineSelected, onGutterUtilityClick],
  );

  const onKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLElement>,
      defaultItemId: string | null | undefined,
      setNative?: (selection: CodeViewLineSelection | null) => void,
    ) => {
      const current = latest.current;
      if (
        !current.active ||
        event.nativeEvent.isComposing ||
        (event.target as HTMLElement).closest(
          "textarea,input,button,[contenteditable=true]",
        )
      )
        return;
      if (event.key === "Escape") {
        const target = current.selection;
        if (
          target &&
          current.review.drafts.getSnapshot(`new:${reviewSelectionKey(target)}`)
            .busy
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (target) cancel(target);
        native.current = { owner: current.review.ownerKey, value: null };
        setNative?.(null);
        setIssue(null);
        return;
      }
      if (
        event.key.toLowerCase() === "m" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        const id = current.selection?.itemId ?? defaultItemId;
        const snapshot = id && current.snapshots.get(id);
        if (!snapshot || !id) return;
        const hunk =
          snapshot.kind === "diff" ? snapshot.fileDiff.hunks[0] : undefined;
        const previous =
          native.current.owner === current.review.ownerKey
            ? native.current.value
            : null;
        const range =
          previous?.id === id
            ? previous.range
            : {
                start: hunk
                  ? hunk.additionCount > 0
                    ? hunk.additionStart
                    : hunk.deletionStart
                  : 1,
                end: hunk
                  ? hunk.additionCount > 0
                    ? hunk.additionStart
                    : hunk.deletionStart
                  : 1,
                ...(hunk
                  ? {
                      side:
                        hunk.additionCount > 0
                          ? ("additions" as const)
                          : ("deletions" as const),
                    }
                  : {}),
              };
        event.preventDefault();
        event.stopPropagation();
        select(id, range, "composer");
        setNative?.({ id, range });
      } else if (
        current.selection?.mode === "selection" &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        const previous =
          native.current.owner === current.review.ownerKey
            ? native.current.value
            : null;
        if (!previous) return;
        const end = previous.range.end + (event.key === "ArrowDown" ? 1 : -1);
        const range = {
          ...previous.range,
          start: event.shiftKey ? previous.range.start : end,
          end,
        };
        const snapshot = current.snapshots.get(previous.id);
        if (!snapshot || !anchorFromSelection(snapshot, range)) return;
        event.preventDefault();
        select(previous.id, range);
        setNative?.({ id: previous.id, range });
      } else if (
        event.key === "Enter" &&
        current.selection?.mode === "selection"
      ) {
        event.preventDefault();
        current.review.drafts.requestFocus(
          `new:${reviewSelectionKey(current.selection)}`,
        );
        setSelection({ ...current.selection, mode: "composer" });
      }
    },
    [cancel, select, setSelection],
  );
  const snapshotFor = useCallback(
    (itemId: string) => snapshots.get(itemId),
    [snapshots],
  );
  return {
    selection,
    issue,
    select,
    setSelection,
    cancel,
    annotationsForDiff,
    annotationsForFile,
    renderAnnotation,
    options,
    onKeyDown,
    snapshotFor,
  };
}
