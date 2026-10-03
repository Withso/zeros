// Standalone development harness. Real native viewers and discussion controls;
// deterministic fixture operations never contact a workspace or GitHub.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  mergeCodeReviewThreads,
  type CodeReviewAnchor,
  type CodeReviewThread,
} from "@zeros/protocol/code-review";
import {
  reviewContentRevision as gitReviewContentRevision,
  reviewHunkKey,
} from "@zeros/protocol/git-review-actions";
import type { GitReviewActionsClient } from "@/renderer/platform/git-review-actions";
import { Button, TooltipProvider } from "@/renderer/shared/ui/primitives";
import {
  ReviewDiffView,
  ReviewSourceView,
} from "@/renderer/features/code-review/review-code-view";
import { ReviewDraftStore } from "@/renderer/features/code-review/review-draft-store";
import { reviewContentRevision } from "@/renderer/features/code-review/review-anchors";
import type {
  CodeReviewExternalSource,
  CodeReviewThreadItem,
} from "@/renderer/features/code-review/review-thread-model";
import type { CodeReviewController } from "@/renderer/features/code-review/use-code-review";
import { SourceEditor } from "@/renderer/shell/workbench/tabs/code-editor/source-editor";
import { liveReviewHunkSource } from "@/renderer/features/code-review/review-hunk-model";

const PATH = "src/cache.ts";
const REVISION = "github:fixture-workspace:pr-7:base-1:head-1";
const STAMP = Date.UTC(2026, 0, 2, 12);
const SOURCE = [
  "type CacheKey = readonly [string, string];",
  "",
  "const snapshots = new Map<string, string>();",
  "export function readSnapshot(key: CacheKey) {",
  "  const exactKey = JSON.stringify(key);",
  "  return snapshots.get(exactKey);",
  "}",
  "",
  "export function publishSnapshot(key: CacheKey, value: string) {",
  "  const exactKey = JSON.stringify(key);",
  "  snapshots.set(exactKey, value);",
  "}",
  "",
  "export function clearSnapshots() {",
  "  snapshots.clear();",
  "}",
  "",
].join("\n");
const OLD_SOURCE = SOURCE.replace(
  "  snapshots.set(exactKey, value);",
  "  snapshots.set(key[0], value);",
);
const PATCH = `diff --git a/${PATH} b/${PATH}\n--- a/${PATH}\n+++ b/${PATH}\n@@ -8,6 +8,6 @@\n \n export function publishSnapshot(key: CacheKey, value: string) {\n   const exactKey = JSON.stringify(key);\n-  snapshots.set(key[0], value);\n+  snapshots.set(exactKey, value);\n }\n \n`;
const CONFLICT =
  "export const cacheMode =\n<<<<<<< HEAD\n  'workspace';\n=======\n  'shared';\n>>>>>>> incoming\n";
const actor = {
  id: "fixture-human",
  name: "Workspace reviewer",
  kind: "human" as const,
};

function anchor(
  startLine: number,
  endLine = startLine,
  side: CodeReviewAnchor["side"] = "file",
  context?: string,
): CodeReviewAnchor {
  return {
    path: PATH,
    side,
    startLine,
    endLine,
    revision: side === "file" ? reviewContentRevision(SOURCE) : REVISION,
    context:
      context ??
      SOURCE.split("\n")
        .slice(startLine - 1, endLine)
        .join("\n"),
  };
}
function seedThreads(): CodeReviewThreadItem[] {
  return [
    {
      id: "local",
      source: "workspace",
      anchor: anchor(4, 6),
      resolved: false,
      version: 1,
      canReply: true,
      canResolve: true,
      comments: [
        {
          id: "local-comment",
          author: actor,
          createdAt: STAMP,
          body: "Keep the **exact workspace key** during refresh.\n\n```ts\nreadSnapshot(['workspace', 'file']);\n```\n\n[Review reference](https://example.com/review)",
        },
      ],
    },
    {
      id: "remote-new",
      source: "github",
      anchor: anchor(11, 11, "new"),
      resolved: false,
      version: "1",
      canReply: true,
      canResolve: true,
      comments: [
        {
          id: "remote-comment",
          author: {
            id: "fixture-bot",
            name: "Review bot",
            kind: "integration",
            provider: "GitHub",
          },
          createdAt: STAMP,
          body: "This preserves both keys. Suggested form:\n\n```suggestion\nsnapshots.set(exactKey, value);\n```",
        },
      ],
    },
    {
      id: "remote-old",
      source: "github",
      anchor: anchor(11, 11, "old", OLD_SOURCE.split("\n")[10]),
      resolved: false,
      version: "1",
      canReply: true,
      canResolve: true,
      comments: [
        {
          id: "remote-old-comment",
          author: { ...actor, name: "PR reviewer" },
          body: "The original key loses file identity.",
          createdAt: STAMP,
        },
      ],
    },
    {
      id: "resolved",
      source: "workspace",
      anchor: anchor(14, 16),
      resolved: true,
      version: 2,
      canReply: true,
      canResolve: true,
      comments: [
        {
          id: "resolved-comment",
          author: actor,
          body: "The cleanup is clear.",
          createdAt: STAMP,
        },
      ],
    },
    {
      id: "stale",
      source: "workspace",
      anchor: anchor(2, 2, "file", "const previousCache = {}"),
      resolved: false,
      version: 1,
      canReply: true,
      canResolve: true,
      comments: [
        {
          id: "stale-comment",
          author: {
            id: "fixture-agent",
            name: "Codex",
            kind: "agent",
            provider: "codex",
          },
          body: "Retain the original anchor after the code changes.",
          createdAt: STAMP,
        },
      ],
    },
    {
      id: "check",
      source: "check",
      anchor: anchor(10, 10, "new"),
      resolved: false,
      version: "1",
      severity: "notice",
      comments: [
        {
          id: "check-comment",
          author: {
            id: "fixture-check",
            name: "Typecheck",
            kind: "integration",
          },
          body: "Exact-key fixture check. **Read only.**",
          createdAt: 0,
        },
      ],
    },
  ];
}

function historyFixture(): CodeReviewThread {
  return {
    id: "history",
    workspaceId: "fixture-workspace",
    anchor: anchor(3),
    resolved: false,
    version: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    commentCount: 200,
    commentsComplete: true,
    comments: Array.from({ length: 200 }, (_, index) => ({
      id: `history-${index + 1}`,
      sequence: index + 1,
      author: actor,
      body: `Workspace history ${index + 1}.`,
      createdAt: STAMP + index,
    })),
  };
}
function historyChunk(
  thread: CodeReviewThread,
  after: number,
): CodeReviewThread {
  const end = Math.min(after + 64, thread.comments.length);
  return {
    ...thread,
    comments: thread.comments.slice(after, end),
    commentCount: thread.comments.length,
    commentsComplete: after === 0 && end === thread.comments.length,
    commentsCursor: end < thread.comments.length ? `after-${end}` : undefined,
    commentsCursorAfter: end,
  };
}
function mergeHistoryFixture(
  current: CodeReviewThreadItem[],
  incoming: CodeReviewThread,
): CodeReviewThreadItem[] {
  const previous = current.find(
    (thread) => thread.source === "workspace" && thread.id === incoming.id,
  );
  const prior: CodeReviewThread[] = previous
    ? [
        {
          ...incoming,
          ...previous,
          version: Number(previous.version),
          comments: [...previous.comments],
        },
      ]
    : [];
  const merged = mergeCodeReviewThreads(prior, [incoming])[0]!;
  const item: CodeReviewThreadItem = {
    ...merged,
    source: "workspace",
    canReply: true,
    canResolve: true,
  };
  return previous
    ? current.map((thread) => (thread === previous ? item : thread))
    : [...current, item];
}

function Harness() {
  const [mode, setMode] = useState<"preview" | "edit" | "diff" | "conflict">(
    "preview",
  );
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [threads, setThreads] = useState(seedThreads);
  const [source, setSource] = useState(SOURCE);
  const [conflictDisk, setConflictDisk] = useState(CONFLICT);
  const [confirmed, setConfirmed] = useState(false);
  const [publishedRevision, setPublishedRevision] = useState(REVISION);
  const [hidden, setHidden] = useState(false);
  const [externalError, setExternalError] = useState(false);
  const [notice, setNotice] = useState(false);
  const [hold, setHold] = useState(false);
  const [failNext, setFailNext] = useState(false);
  const [pending, setPending] = useState(0);
  const [lastAction, setLastAction] = useState("Ready");
  const [hunks, setHunks] = useState(false);
  const [collectionCursor, setCollectionCursor] = useState<string>();
  const [pagination, setPagination] = useState(false);
  const initialHistory = useMemo(historyFixture, []);
  const historyStore = useRef(initialHistory);
  const drafts = useMemo(() => new ReviewDraftStore(), []);
  const control = useRef({ failNext, hold });
  control.current = { failNext, hold };
  const releases = useRef<Array<() => void>>([]);
  const sequence = useRef(0);
  const perform = useCallback(async () => {
    const fail = control.current.failNext;
    if (fail) {
      control.current.failNext = false;
      setFailNext(false);
    }
    if (control.current.hold) {
      setPending((count) => count + 1);
      await new Promise<void>((done) => releases.current.push(done));
      setPending((count) => count - 1);
    }
    if (fail) throw new Error("Fixture submission failed. Your draft is kept.");
  }, []);
  const create = useCallback(
    async (
      selected: CodeReviewAnchor,
      body: string,
      sourceKind: "workspace" | "github",
    ) => {
      await perform();
      const id = `created-${++sequence.current}`;
      setThreads((current) => [
        ...current,
        {
          id,
          source: sourceKind,
          anchor: selected,
          resolved: false,
          version: 1,
          canReply: true,
          canResolve: true,
          comments: [
            {
              id: `${id}-comment`,
              author: actor,
              body,
              createdAt: STAMP + sequence.current,
            },
          ],
        },
      ]);
      setLastAction(
        `${sourceKind} create ${selected.side} ${selected.startLine}–${selected.endLine}`,
      );
    },
    [perform],
  );
  const reply = useCallback(
    async (thread: CodeReviewThreadItem, body: string) => {
      await perform();
      const id = `reply-${++sequence.current}`;
      if (thread.id === "history" && thread.source === "workspace") {
        const previous = historyStore.current;
        const next = {
          ...previous,
          version: previous.version + 1,
          updatedAt: STAMP + sequence.current,
          comments: [
            ...previous.comments,
            {
              id,
              sequence: previous.comments.length + 1,
              author: actor,
              body,
              createdAt: STAMP + sequence.current,
            },
          ],
        };
        historyStore.current = next;
        const preview = {
          ...next,
          comments: [next.comments[0]!, next.comments.at(-1)!],
          commentCount: next.comments.length,
          commentsComplete: false,
          commentsCursor: "after-1",
          commentsCursorAfter: 1,
        };
        setThreads((current) => mergeHistoryFixture(current, preview));
        setLastAction("reply history");
        return;
      }
      setThreads((current) =>
        current.map((item) =>
          item.id === thread.id
            ? {
                ...item,
                version: Number(item.version) + 1,
                comments: [
                  ...item.comments,
                  {
                    id,
                    author: actor,
                    body,
                    createdAt: STAMP + sequence.current,
                  },
                ],
              }
            : item,
        ),
      );
      setLastAction(`reply ${thread.id}`);
    },
    [perform],
  );
  const loadMoreComments = useCallback(
    async (thread: CodeReviewThreadItem) => {
      if (thread.id !== "history" || !thread.commentsCursor) return;
      const after = Number(thread.commentsCursor.replace("after-", ""));
      await perform();
      setThreads((current) =>
        mergeHistoryFixture(current, historyChunk(historyStore.current, after)),
      );
      setLastAction(`load history after ${after}`);
    },
    [perform],
  );
  const loadMore = useCallback(async () => {
    if (!collectionCursor) return;
    const after = Number(collectionCursor.replace("collection-", ""));
    await perform();
    setThreads((current) =>
      mergeHistoryFixture(current, historyChunk(historyStore.current, after)),
    );
    setCollectionCursor(undefined);
    setLastAction(`load workspace page after ${after}`);
  }, [collectionCursor, perform]);
  const setResolved = useCallback(
    async (thread: CodeReviewThreadItem, resolved: boolean) => {
      await perform();
      setThreads((current) =>
        current.map((item) =>
          item.id === thread.id
            ? { ...item, resolved, version: Number(item.version) + 1 }
            : item,
        ),
      );
      setLastAction(`${resolved ? "resolve" : "reopen"} ${thread.id}`);
    },
    [perform],
  );
  const external = useMemo<CodeReviewExternalSource>(
    () => ({
      threads: threads.filter((thread) => thread.source !== "workspace"),
      reply,
      setResolved,
      ...(confirmed ? { confirmedRevision: publishedRevision } : {}),
      createLabel: "Post to PR",
      postComment: (selected, body) => create(selected, body, "github"),
      error: externalError
        ? "Fixture GitHub read failed. Last confirmed comments are retained."
        : null,
      notice: notice
        ? "More GitHub comments and check annotations are available at the source."
        : null,
    }),
    [
      threads,
      reply,
      setResolved,
      confirmed,
      publishedRevision,
      create,
      externalError,
      notice,
    ],
  );
  const review = useMemo<CodeReviewController>(
    () => ({
      ownerKey: "fixture-workspace",
      threads,
      drafts,
      external,
      loading: false,
      error: null,
      refresh: () => setExternalError(false),
      partial: !!collectionCursor,
      nextCursor: collectionCursor,
      loadMore,
      viewerActorId: pagination ? actor.id : undefined,
      operations: {
        create: (selected, body) => create(selected, body, "workspace"),
        reply,
        setResolved,
        loadMoreComments,
      },
    }),
    [
      threads,
      drafts,
      external,
      create,
      reply,
      setResolved,
      collectionCursor,
      loadMore,
      pagination,
      loadMoreComments,
    ],
  );
  const actionClient = useMemo<GitReviewActionsClient>(
    () => ({
      identity: "fixture-actions",
      list: async () => ({ workspaceId: "fixture-workspace", decisions: [] }),
      review: async (_cwd, input) => {
        await perform();
        setLastAction(`${input.decision} hunk`);
        return {
          decision: {
            key: reviewHunkKey(
              input.path,
              input.comparison,
              input.patch,
              gitReviewContentRevision(input.expectedContent),
            ),
            path: input.path,
            comparison: input.comparison,
            decision: input.decision,
            updatedAt: STAMP,
          },
          fileChanged: input.decision === "rejected",
        };
      },
      resolveConflict: async (_cwd, input) => {
        await perform();
        setConflictDisk(input.content);
        setLastAction("save resolution");
        return {
          kind: "success",
          path: input.path,
          bytes: new TextEncoder().encode(input.content).length,
        };
      },
    }),
    [perform],
  );
  const hunkSource = useMemo(() => {
    if (!hunks || confirmed) return;
    const live = liveReviewHunkSource({
      cwd: "/review-fixture",
      path: PATH,
      patch: PATCH,
      scope: "uncommitted",
      read: { path: PATH, kind: "text", bytes: SOURCE.length, content: SOURCE },
    });
    return live && { ...live, client: actionClient };
  }, [hunks, confirmed, actionClient]);

  return (
    <TooltipProvider delayDuration={300}>
      <main
        data-testid="code-review-harness"
        className="bg-bg1 text-fg1 flex h-screen min-h-0 flex-col p-4 font-sans"
      >
        <div className="border-border1 mb-2 flex flex-wrap items-center gap-1 border-b pb-2">
          <span className="mr-3 text-sm font-medium">Inline review</span>
          {(["preview", "edit", "diff", "conflict"] as const).map((item) => (
            <Button
              key={item}
              variant={mode === item ? "secondary-on" : "ghost"}
              data-testid={`review-mode-${item}`}
              onClick={() => setMode(item)}
            >
              {item === "preview"
                ? "Files preview"
                : item === "edit"
                  ? "Files edit"
                  : item === "diff"
                    ? "Changes diff"
                    : "Conflict source"}
            </Button>
          ))}
          <Button
            variant="ghost"
            data-testid="review-toggle-split"
            onClick={() =>
              setStyle((current) =>
                current === "unified" ? "split" : "unified",
              )
            }
          >
            {style === "unified" ? "Show split" : "Show unified"}
          </Button>
          <Button
            variant="ghost"
            data-testid="review-toggle-confirmed"
            aria-pressed={confirmed}
            onClick={() => setConfirmed(!confirmed)}
          >
            Confirmed PR diff: {confirmed ? "on" : "off"}
          </Button>
          <Button
            variant="ghost"
            data-testid="review-change-pr-base"
            onClick={() =>
              setPublishedRevision((current) =>
                current.replace(/base-\d+/, (value) =>
                  value === "base-1" ? "base-2" : "base-1",
                ),
              )
            }
          >
            Change PR base, keep head
          </Button>
          <Button
            variant="ghost"
            data-testid="review-change-pr"
            onClick={() =>
              setPublishedRevision((current) =>
                current.replace(/pr-\d+/, (value) =>
                  value === "pr-7" ? "pr-8" : "pr-7",
                ),
              )
            }
          >
            Change PR, keep head
          </Button>
          <Button
            variant="ghost"
            data-testid="review-toggle-hunks"
            aria-pressed={hunks}
            onClick={() => setHunks(!hunks)}
          >
            Hunk actions: {hunks ? "on" : "off"}
          </Button>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            data-testid="review-fail-next"
            aria-pressed={failNext}
            onClick={() => setFailNext(true)}
          >
            Fail next submission
          </Button>
          <Button
            variant="ghost"
            data-testid="review-hold-submissions"
            aria-pressed={hold}
            onClick={() => setHold(!hold)}
          >
            Hold submissions: {hold ? "on" : "off"}
          </Button>
          <Button
            variant="ghost"
            data-testid="review-release-submissions"
            disabled={!pending}
            onClick={() => releases.current.splice(0).forEach((done) => done())}
          >
            Release {pending} submissions
          </Button>
          <Button
            variant="ghost"
            data-testid="review-change-code"
            onClick={() =>
              setSource((current) =>
                current === SOURCE
                  ? SOURCE.replace(
                      "return snapshots.get(exactKey);",
                      "return undefined;",
                    )
                  : SOURCE,
              )
            }
          >
            Change source context
          </Button>
          <Button
            variant="ghost"
            data-testid="review-toggle-error"
            onClick={() => setExternalError(!externalError)}
          >
            Toggle read error
          </Button>
          <Button
            variant="ghost"
            data-testid="review-toggle-notice"
            onClick={() => setNotice(!notice)}
          >
            Toggle truncation notice
          </Button>
          <Button
            variant="ghost"
            data-testid="review-toggle-hidden"
            onClick={() => setHidden(!hidden)}
          >
            {hidden ? "Show surface" : "Hide surface"}
          </Button>
          <Button
            variant="ghost"
            data-testid="review-paginate-local"
            onClick={() => {
              setPagination(true);
              setCollectionCursor("collection-64");
              setThreads((current) =>
                mergeHistoryFixture(
                  current.filter((thread) => thread.id !== "history"),
                  historyChunk(historyStore.current, 0),
                ),
              );
            }}
          >
            Load workspace history fixture
          </Button>
          <Button
            variant="ghost"
            data-testid="review-empty-local-page"
            onClick={() => {
              setPagination(true);
              setCollectionCursor("collection-0");
              setThreads((current) =>
                current.filter((thread) => thread.source !== "workspace"),
              );
            }}
          >
            Empty authorized workspace page
          </Button>
          <Button
            variant="ghost"
            data-testid="review-history-preview"
            disabled={!pagination}
            onClick={() => {
              const full = historyStore.current;
              setThreads((current) =>
                mergeHistoryFixture(current, {
                  ...full,
                  comments: [full.comments[0]!, full.comments.at(-1)!],
                  commentCount: full.comments.length,
                  commentsComplete: false,
                  commentsCursor: "after-1",
                  commentsCursorAfter: 1,
                }),
              );
            }}
          >
            Merge root/latest preview
          </Button>
        </div>
        <p className="text-fg3 mb-2 text-xs">
          Click or drag line numbers. Shift extends a range. Command/Control
          Shift M comments; Escape cancels; Command/Control Enter submits.
        </p>
        <output
          data-testid="review-last-action"
          className="text-fg3 mb-2 text-xs"
        >
          {lastAction}
        </output>
        <div
          data-testid="review-viewer"
          className="border-border1 relative min-h-0 flex-1 overflow-hidden rounded-md border"
        >
          <div
            className={hidden ? "hidden h-full" : "h-full"}
            aria-hidden={hidden || undefined}
            {...(hidden ? { inert: "" } : {})}
          >
            {mode === "preview" && (
              <ReviewSourceView
                path={PATH}
                content={source}
                review={review}
                active={!hidden}
              />
            )}
            {mode === "edit" && (
              <SourceEditor
                editorId="review-fixture-editor"
                cwd="/review-fixture"
                path={PATH}
                content={source}
                review={review}
                offscreen={hidden}
              />
            )}
            {mode === "diff" && (
              <ReviewDiffView
                path={PATH}
                patch={PATCH}
                review={review}
                active={!hidden}
                diffStyle={style}
                confirmedRevision={confirmed ? publishedRevision : undefined}
                hunkSource={hunkSource}
              />
            )}
            {mode === "conflict" && (
              <SourceEditor
                editorId="review-fixture-conflict"
                cwd="/review-fixture"
                path="src/conflict.ts"
                content={conflictDisk}
                review={review}
                isGitConflict
                offscreen={hidden}
                reviewActionClient={actionClient}
              />
            )}
          </div>
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
