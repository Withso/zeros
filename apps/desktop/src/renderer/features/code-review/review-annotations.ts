import type { DiffLineAnnotation, LineAnnotation } from "@pierre/diffs";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import {
  reviewContentRevision,
  reviewThreadPlacement,
  threadBelongsToSnapshot,
  type ReviewAnchorState,
  type ReviewCodeSnapshot,
} from "./review-anchors";
import {
  reviewThreadKey,
  reviewThreadRenderVersion,
  type CodeReviewThreadItem,
} from "./review-thread-model";
import {
  reviewHunkPlacements,
  type ReviewHunkTarget,
  type ReviewLiveHunkSource,
} from "./review-hunk-model";

export interface ReviewSelectionTarget {
  itemId: string;
  anchor: CodeReviewAnchor;
  mode: "selection" | "composer";
  postToPr?: boolean;
  confirmedRevision?: string;
}
export interface ReviewAnnotationThread {
  thread: CodeReviewThreadItem;
  state: ReviewAnchorState;
}
export interface ReviewAnnotationPayload {
  id: string;
  threads: readonly ReviewAnnotationThread[];
  selection?: ReviewSelectionTarget;
  hunks?: readonly ReviewHunkTarget[];
}
export type ReviewAnnotation =
  | LineAnnotation<ReviewAnnotationPayload>
  | DiffLineAnnotation<ReviewAnnotationPayload>;
const annotationVersions = new WeakMap<readonly ReviewAnnotation[], string>();

export function reviewSelectionKey(target: ReviewSelectionTarget): string {
  const a = target.anchor;
  return JSON.stringify([
    target.itemId,
    a.path,
    a.side,
    a.startLine,
    a.endLine,
    a.revision,
  ]);
}

export function reviewAnnotationVersion(
  annotations: readonly ReviewAnnotation[],
): string {
  const existing = annotationVersions.get(annotations);
  if (existing) return existing;
  const version = reviewContentRevision(
    JSON.stringify(
      annotations.map((annotation) => [
        annotation.metadata.id,
        annotation.metadata.threads.map(({ thread, state }) => [
          reviewThreadKey(thread),
          reviewThreadRenderVersion(thread),
          state,
        ]),
        annotation.metadata.selection && [
          reviewSelectionKey(annotation.metadata.selection),
          annotation.metadata.selection.mode,
          annotation.metadata.selection.postToPr,
        ],
        annotation.metadata.hunks?.map((hunk) => hunk.key),
      ]),
    ),
  );
  annotationVersions.set(annotations, version);
  return version;
}

interface AnnotationEntry {
  signature: string;
  annotations: ReviewAnnotation[];
}

/** One stable array/payload per unchanged native line slot, bounded per viewer. */
export class ReviewAnnotationCache {
  private readonly entries = new Map<string, AnnotationEntry>();
  constructor(private readonly maxEntries = 128) {}

  forDiff(
    snapshot: Extract<ReviewCodeSnapshot, { kind: "diff" }>,
    threads: readonly CodeReviewThreadItem[],
    selection?: ReviewSelectionTarget,
    hunkSource?: ReviewLiveHunkSource,
    active = true,
  ): DiffLineAnnotation<ReviewAnnotationPayload>[] {
    return this.build(
      snapshot,
      threads,
      selection,
      hunkSource,
      active,
    ) as DiffLineAnnotation<ReviewAnnotationPayload>[];
  }
  forFile(
    snapshot: Extract<ReviewCodeSnapshot, { kind: "file" }>,
    threads: readonly CodeReviewThreadItem[],
    selection?: ReviewSelectionTarget,
    active = true,
  ): LineAnnotation<ReviewAnnotationPayload>[] {
    return this.build(
      snapshot,
      threads,
      selection,
      undefined,
      active,
    ) as LineAnnotation<ReviewAnnotationPayload>[];
  }

  private build(
    snapshot: ReviewCodeSnapshot,
    threads: readonly CodeReviewThreadItem[],
    selection?: ReviewSelectionTarget,
    hunkSource?: ReviewLiveHunkSource,
    active = true,
  ): ReviewAnnotation[] {
    const relevant = threads.filter((thread) =>
      threadBelongsToSnapshot(thread, snapshot),
    );
    const signature = JSON.stringify([
      snapshot.revision,
      // Pierre caches measured line heights, including zero-sized hidden rows.
      // A resume publishes a new native array to reset those measurements;
      // unchanged payload identities and draft ownership remain stable.
      active,
      snapshot.kind === "diff" && [
        snapshot.confirmedRevision,
        snapshot.fileDiff.isPartial,
        snapshot.fileDiff.additionLines.length,
        snapshot.fileDiff.deletionLines.length,
      ],
      relevant.map((thread) => [
        reviewThreadKey(thread),
        reviewThreadRenderVersion(thread),
      ]),
      selection && [
        reviewSelectionKey(selection),
        selection.mode,
        selection.postToPr,
      ],
      hunkSource && [
        hunkSource.cwd,
        hunkSource.path,
        hunkSource.comparison,
        hunkSource.contentRevision,
        reviewContentRevision(hunkSource.patch),
      ],
    ]);
    const key = `${snapshot.kind}:${snapshot.path}`;
    const existing = this.entries.get(key);
    if (existing?.signature === signature) return existing.annotations;
    const groups = new Map<string, ReviewAnnotation>();
    const group = (
      lineNumber: number,
      side: CodeReviewAnchor["side"],
    ): ReviewAnnotation => {
      const nativeSide = side === "old" ? "deletions" : "additions";
      const id =
        snapshot.kind === "file"
          ? `review:${lineNumber}`
          : `review:${nativeSide}:${lineNumber}`;
      let entry = groups.get(id);
      if (!entry) {
        entry = {
          lineNumber,
          ...(snapshot.kind === "diff" ? { side: nativeSide } : {}),
          metadata: { id, threads: [] },
        };
        groups.set(id, entry);
      }
      return entry;
    };
    for (const thread of relevant) {
      const placement = reviewThreadPlacement(thread, snapshot);
      // Discussions without a verified current line remain readable in the
      // viewer footer. Only current anchors enter native inline slots.
      if (placement.lineNumber === 0) continue;
      const entry = group(placement.lineNumber, thread.anchor.side);
      entry.metadata.threads = [
        ...entry.metadata.threads,
        { thread, state: placement.state },
      ];
    }
    if (selection) {
      const placement = reviewThreadPlacement(
        {
          id: "draft",
          source: "workspace",
          anchor: selection.anchor,
          comments: [],
          resolved: false,
          version: 0,
        },
        snapshot,
      );
      group(placement.lineNumber, selection.anchor.side).metadata.selection =
        selection;
    }
    if (snapshot.kind === "diff" && hunkSource) {
      for (const placement of reviewHunkPlacements(snapshot, hunkSource)) {
        const entry = group(placement.lineNumber, placement.side);
        entry.metadata.hunks = [
          ...(entry.metadata.hunks ?? []),
          placement.target,
        ];
      }
    }
    const annotations = [...groups.values()].sort(
      (a, b) =>
        a.lineNumber - b.lineNumber ||
        a.metadata.id.localeCompare(b.metadata.id),
    );
    // Reuse unaffected line payloads when another thread or selection changes.
    if (existing) {
      const previous = new Map(
        existing.annotations.map((entry) => [entry.metadata.id, entry]),
      );
      for (let index = 0; index < annotations.length; index++) {
        const current = annotations[index]!;
        const old = previous.get(current.metadata.id);
        if (
          old &&
          old.metadata.selection === current.metadata.selection &&
          (old.metadata.hunks === current.metadata.hunks ||
            (old.metadata.hunks?.length === current.metadata.hunks?.length &&
              old.metadata.hunks?.every(
                (hunk, at) => hunk === current.metadata.hunks?.[at],
              ))) &&
          old.metadata.threads.length === current.metadata.threads.length &&
          old.metadata.threads.every(
            (entry, at) =>
              entry.thread === current.metadata.threads[at]?.thread &&
              entry.state === current.metadata.threads[at]?.state,
          )
        )
          annotations[index] = old;
      }
    }
    this.entries.delete(key);
    this.entries.set(key, { signature, annotations });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
    return annotations;
  }
}

export function reviewUnplacedThreads(
  snapshot: ReviewCodeSnapshot,
  threads: readonly CodeReviewThreadItem[],
): ReviewAnnotationThread[] {
  return threads
    .filter((thread) => threadBelongsToSnapshot(thread, snapshot))
    .flatMap((thread) => {
      const placement = reviewThreadPlacement(thread, snapshot);
      return placement.lineNumber === 0
        ? [{ thread, state: placement.state }]
        : [];
    });
}
