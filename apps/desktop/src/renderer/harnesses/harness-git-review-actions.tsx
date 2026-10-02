// Real standalone controls; only the engine transport is faked.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "/styles/zeros-tokens.css";
import "/styles/semantic-tokens.css";
import "/styles/globals.css";
import {
  applyConflictChoices,
  reverseReviewHunkContent,
  reviewContentRevision,
  reviewHunkKey,
  type HunkReviewDecision,
  type HunkReviewResult,
} from "@zeros/protocol/git-review-actions";
import type { GitReviewActionsClient } from "../platform/git-review-actions";
import { HunkReviewActions } from "../features/code-review/hunk-review-actions";
import { MergeConflictActions } from "../features/code-review/merge-conflict-actions";

const params = new URLSearchParams(location.search);
const hunkContent = "before\nchanged\nend\n";
const patch =
  "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n before\n-original\n+changed\n end\n";
const conflictContent =
  "prefix\r\n<<<<<<< HEAD\r\ncurrent one\r\n||||||| base\r\nold one\r\n=======\r\nincoming one\r\n>>>>>>> topic\r\nbetween\r\n<<<<<<< HEAD\r\ncurrent two\r\n=======\r\nincoming two\r\n>>>>>>> topic";
let disk: string | null = params.get("conflicts")
  ? conflictContent
  : hunkContent;
let decisions: HunkReviewDecision[] = [];
const requests: Array<{ op: string; cwd: string; input: unknown }> = [];
const reviewed: HunkReviewResult[] = [];
const previews: string[] = [];
const saved: string[] = [];
let release: (() => void) | undefined;
const held = params.get("hold")
  ? new Promise<void>((resolve) => {
      release = resolve;
    })
  : Promise.resolve();
const fixture = {
  ready: false,
  requests,
  reviewed,
  previews,
  saved,
  initialConflict: conflictContent,
  disk: () => disk,
  changeDisk: (content: string) => {
    disk = content;
  },
  release: () => release?.(),
  setActive: (_active: boolean) => {},
  setReadOnly: (_readOnly: boolean) => {},
  setShown: (_shown: boolean) => {},
  refresh: (_content: string) => {},
};
Object.assign(window, { reviewActionsFixture: fixture });
const stale = () =>
  new Error("The file changed. Refresh before saving; your preview is kept.");
const client: GitReviewActionsClient = {
  identity: "review-actions-harness",
  list: async (cwd, path) => {
    requests.push({ op: "list", cwd, input: { path } });
    return { workspaceId: cwd, decisions };
  },
  review: async (cwd, input) => {
    requests.push({ op: "review", cwd, input });
    await held;
    if (input.expectedContent !== disk) throw stale();
    if (input.decision === "rejected")
      disk = reverseReviewHunkContent(disk, input.patch);
    const decision: HunkReviewDecision = {
      key: reviewHunkKey(
        input.path,
        input.comparison,
        input.patch,
        reviewContentRevision(input.expectedContent),
      ),
      path: input.path,
      comparison: input.comparison,
      decision: input.decision,
      updatedAt: Date.now(),
    };
    decisions = [
      ...decisions.filter((item) => item.key !== decision.key),
      decision,
    ];
    return { decision, fileChanged: input.decision === "rejected" };
  },
  resolveConflict: async (cwd, input) => {
    requests.push({ op: "resolve", cwd, input });
    await held;
    if (input.expectedContent !== disk) throw stale();
    const preview = applyConflictChoices(input.expectedContent, input.choices);
    if (preview.remaining || preview.content !== input.content)
      throw new Error("Choose every conflict.");
    disk = input.content;
    return {
      kind: "success",
      path: input.path,
      bytes: new TextEncoder().encode(input.content).length,
    };
  },
};

function Harness() {
  const [active, setActive] = useState(!params.has("inactive"));
  const [readOnly, setReadOnly] = useState(params.has("readonly"));
  const [shown, setShown] = useState(true);
  const [content, setContent] = useState(conflictContent);
  const [preview, setPreview] = useState(conflictContent);
  useEffect(() => {
    fixture.ready = true;
    fixture.setActive = setActive;
    fixture.setReadOnly = setReadOnly;
    fixture.setShown = setShown;
    fixture.refresh = (next) => {
      disk = next;
      setContent(next);
    };
  }, []);
  const gate = { active, readOnly, designPath: params.has("design"), client };
  const onReviewed = (result: HunkReviewResult) => {
    reviewed.push(result);
    if (result.fileChanged) setShown(false);
  };
  return (
    <main className="bg-bg1 text-fg1 mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-sm font-medium">Git review actions</h1>
      {params.has("conflicts") ? (
        <>
          {shown && (
            <MergeConflictActions
              cwd="/review-fixture"
              path="file.txt"
              content={content}
              isGitConflict={!params.has("historical")}
              {...gate}
              onPreview={(next) => {
                previews.push(next);
                setPreview(next);
              }}
              onSaved={(next) => {
                saved.push(next);
                setContent(next);
                setPreview(next);
              }}
            />
          )}
          <pre data-resolution-preview className="text-xs whitespace-pre-wrap">
            {preview}
          </pre>
        </>
      ) : (
        shown && (
          <>
            <HunkReviewActions
              cwd="/review-fixture"
              path="file.txt"
              patch={patch}
              comparison="worktree-vs-head"
              expectedContent={hunkContent}
              {...gate}
              readOnly={readOnly || params.has("historical")}
              onReviewed={onReviewed}
            />
            {params.has("twins") && (
              <HunkReviewActions
                cwd="/review-fixture"
                path="file.txt"
                patch={patch}
                comparison="worktree-vs-head"
                expectedContent={hunkContent}
                {...gate}
                onReviewed={onReviewed}
              />
            )}
          </>
        )
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
