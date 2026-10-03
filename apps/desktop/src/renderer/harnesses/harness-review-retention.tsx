// Real review viewers retain their React lifetime while visiting many files.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CodeReviewAnchor } from "@zeros/protocol/code-review";
import {
  ReviewSourceView,
  ReviewDiffView,
} from "../features/code-review/review-code-view";
import { ReviewDraftStore } from "../features/code-review/review-draft-store";
import { reviewContentRevision } from "../features/code-review/review-anchors";
import { useInlineReview } from "../features/code-review/use-inline-review";
import type { CodeReviewController } from "../features/code-review/use-code-review";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

const posted: { anchor: CodeReviewAnchor; body: string }[] = [];
const review: CodeReviewController = {
  ownerKey: "retained-source-owner",
  threads: [],
  drafts: new ReviewDraftStore(),
  operations: {
    create: async (anchor, body) => {
      posted.push({ anchor, body });
    },
    reply: async () => {},
    setResolved: async () => {},
  },
  loading: false,
  error: null,
  refresh: () => {},
};
const contentFor = (path: string) =>
  `const source = "${path}";\nexport { source };\n`;
const patchFor = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-const source = "before";\n+const source = "${path}";\n export { source };\n`;
type Mode = "source" | "diff";

function Viewer({ path, mode }: { path: string; mode: Mode }) {
  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 h-[500px] w-[700px]">
        {mode === "source" ? (
          <ReviewSourceView
            path={path}
            content={contentFor(path)}
            review={review}
            active
          />
        ) : (
          <ReviewDiffView
            path={path}
            patch={patchFor(path)}
            review={review}
            active
            diffStyle="unified"
          />
        )}
      </main>
    </TooltipProvider>
  );
}

let readProbe: (path: string) => boolean = () => false;
function MultipleSnapshots({ paths }: { paths: readonly string[] }) {
  const inline = useInlineReview(review, true, paths);
  for (const path of paths) {
    const content = contentFor(path);
    inline.annotationsForFile(path, {
      kind: "file",
      path,
      content,
      revision: reviewContentRevision(content),
    });
  }
  readProbe = (path) => inline.snapshotFor(path) !== undefined;
  return <div>Multiple visible review sources</div>;
}

const root = createRoot(document.getElementById("root")!);

// The regression inspects the committed viewer's actual retained sources, not
// a duplicate cache. Match values by shape, without depending on hook order.
interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}
interface Fiber {
  type?: { name?: string };
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedState: Hook | null;
}
function viewerFiber(fiber: Fiber | null): Fiber | null {
  if (!fiber) return null;
  if (fiber.type?.name === "ReviewedCodeView") return fiber;
  return viewerFiber(fiber.child) ?? viewerFiber(fiber.sibling);
}
function retainedSources() {
  const current = (root as unknown as { _internalRoot: { current: Fiber } })
    ._internalRoot.current;
  const fiber = viewerFiber(current);
  if (!fiber) throw new Error("The real review viewer is not mounted.");
  let snapshots: string[] | undefined;
  let prepared: string[] | undefined;
  for (let hook = fiber.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    const value = Array.isArray(state) ? state[0] : null;
    if (!(value instanceof Map) || value.size === 0) continue;
    const first = value.values().next().value as Record<string, unknown>;
    if (first.kind === "file" || first.kind === "diff")
      snapshots = [...value.keys()];
    if (first.type === "file" || first.type === "diff")
      prepared = [...value.keys()];
  }
  if (!snapshots || !prepared)
    throw new Error("Expected both review source owners.");
  return { snapshots, prepared };
}

const fixture = {
  posted,
  show(path: string, mode: Mode = "source") {
    flushSync(() => root.render(<Viewer path={path} mode={mode} />));
  },
  showMultiple(paths: string[]) {
    flushSync(() => root.render(<MultipleSnapshots paths={paths} />));
  },
  hasSnapshot(path: string) {
    return readProbe(path);
  },
  retainedSources,
};
declare global {
  interface Window {
    reviewRetentionFixture: typeof fixture;
  }
}
window.reviewRetentionFixture = fixture;
fixture.show("file-0.ts");
