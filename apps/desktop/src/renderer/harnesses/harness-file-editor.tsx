// Real Files, tabs, tree and Pierre editors. Only workspace I/O is simulated;
// writes can be held to exercise typing, navigation and failure races.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import { createTwoFilesPatch } from "diff";
import { Toaster, toast } from "sonner";
import type { Workspace, StatusResult } from "../platform/git";
import type { BridgeMessage } from "../platform/bridge/messages";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import { setSetting } from "../platform/settings";
import { useWorkspaceStore } from "../state/workspace-store";
import { setWorkspaceRowsForTesting } from "../state/use-projects";
import { FilesTab } from "../shell/workbench/tabs/files-tab";
import { WorkbenchTabStrip } from "../shell/workbench/tab-strip";
import { WorkbenchTabFrame } from "../shell/workbench/tab-status";
import { defaultScopeFor } from "../shell/workbench/tab-model";
import { buildDirectFileOpenAction } from "../shell/workbench/direct-file-open";
import { DiffWorkerPoolProvider } from "../shell/workbench/diff-worker-pool";
import { triggerGitRefresh } from "../shell/use-git-refresh-key";
import { ActionsCtx } from "../features/agent/sessions-context";
import { TooltipProvider } from "../shared/ui/primitives";
import { setPrefs } from "../shared/theme/store";

const owner = new URLSearchParams(location.search).get("owner") ?? "personal";
const cloud =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const roots = [
  owner === "cloud" ? cloud : `/${owner}/project`,
  "/organization/other",
];
const workspaces = roots.map(
  (root, index) =>
    ({
      id: owner === "plain" ? `local:editor-${index}` : root,
      path: root,
      repoRoot: root,
      repoSlug: `editor-${index}`,
      baseBranch: "main",
    }) as Workspace,
);
setSetting(
  "projects-v1",
  workspaces.map((workspace, index) => ({
    id: `project-${index}`,
    name: `Files ${index}`,
    repoRoot: workspace.path,
    repoSlug: workspace.repoSlug,
    originUrl: null,
    addedAt: 1,
    isGitRepository: owner !== "plain",
  })),
);
for (const workspace of workspaces)
  setWorkspaceRowsForTesting(workspace.repoSlug, [workspace]);

const BEFORE = Array.from(
  { length: 48 },
  (_, i) => `export const line${i + 1} = ${i + 1};\n`,
).join("");
const SOURCE = BEFORE.replace("line8 = 8", "line8 = 80");
const CONFLICT = "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> incoming\n";
const initial: Record<string, string> = {
  "sample.ts": SOURCE,
  "notes.md": "# Notes\n\nEditable notes.\n",
  "clean.ts": "export const clean = true;\n",
  "restored.ts": "export const restored = true;\n",
  "empty.txt": "",
  "new.txt": "new file\n",
  "renamed.ts": "export const renamed = true;\n",
  "crlf.ts": "first\r\nsecond\r\nthird",
  "conflict.ts": CONFLICT,
};
const files = new Map(
  roots.map((root) => [root, new Map(Object.entries(initial))]),
);
const base = new Map(
  Object.entries({
    ...initial,
    "sample.ts": BEFORE,
    "crlf.ts": "first\r\nold\r\nthird",
    "gone.ts": "deleted\n",
  }),
);
base.delete("new.txt");
base.delete("empty.txt");
let holdWrites = false;
let failNext = false;
const pending: (() => void)[] = [];
const writes: { root: string; path: string; content: string }[] = [];
const requests: { op?: string; params?: Record<string, unknown> }[] = [];
const noop = () => {};
function status(root: string): StatusResult {
  const current = files.get(root)!;
  return {
    staged: [
      { path: "renamed.ts", oldPath: "old.ts", status: "renamed" },
      { path: "restored.ts", status: "added" },
    ],
    unstaged: [...base]
      .filter(
        ([path, content]) =>
          path !== "renamed.ts" && current.get(path) !== content,
      )
      .map(([path]) => ({
        path,
        status: current.has(path) ? "modified" : "deleted",
      })),
    untracked: [...current.keys()].filter((path) => !base.has(path)),
    conflicted: [{ path: "conflict.ts", status: "conflicted" }],
    conflictState: "merge",
  };
}
function patch(root: string, path: string): string {
  const before = base.get(path),
    after = files.get(root)!.get(path);
  if (before === after)
    return path === "renamed.ts"
      ? "diff --git a/old.ts b/renamed.ts\nsimilarity index 100%\nrename from old.ts\nrename to renamed.ts\n"
      : "";
  if (before === undefined) return "";
  return (
    `diff --git a/${path} b/${path}\n${after === undefined ? "deleted file mode 100644\n" : ""}` +
    createTwoFilesPatch(
      `a/${path}`,
      after === undefined ? "/dev/null" : `b/${path}`,
      before,
      after ?? "",
      undefined,
      undefined,
      { context: Infinity },
    )
  );
}
class FixtureBridge extends WorkspaceRuntimeClient {
  constructor() {
    super({
      open: async () => {
        throw new Error("Unexpected connection");
      },
      workspaces: () => workspaces.map((workspace) => ({ ...workspace })),
    });
  }
  override get status() {
    return "connected" as const;
  }
  override statusForWorkspace() {
    return "connected" as const;
  }
  override onWorkspaceStatusChange(_folder: string, callback: () => void) {
    callback();
    return noop;
  }
  override async request<T extends BridgeMessage = BridgeMessage>(
    message: Partial<BridgeMessage> & { type: string },
  ): Promise<T> {
    const request = message as {
      op?: string;
      params?: Record<string, unknown>;
    };
    requests.push(request);
    if (owner === "plain" && request.op === "git.diff")
      throw new Error("not a git repository");
    const root = String(request.params?.workspaceId ?? roots[0]);
    const path = String(request.params?.path ?? request.params?.filePath ?? "");
    const current = files.get(root) ?? files.get(roots[0])!;
    let result: unknown = {};
    if (request.op === "file.read")
      result = current.has(path)
        ? {
            kind: "text",
            path,
            content: current.get(path),
            bytes: current.get(path)!.length,
          }
        : {
            kind: "error",
            path,
            bytes: 0,
            error: "file no longer exists on disk",
          };
    if (request.op === "file.write") {
      const content = String(request.params?.content ?? "");
      writes.push({ root, path, content });
      if (holdWrites)
        await new Promise<void>((resolve) => pending.push(resolve));
      if (failNext) {
        failNext = false;
        result = {
          kind: "error",
          path,
          bytes: 0,
          error: "Fixture write failed",
        };
      } else {
        current.set(path, content);
        result = { kind: "success", path, bytes: content.length };
      }
    }
    if (request.op === "file.tree")
      result = { files: [...current.keys(), "gone.ts"], designDirectories: [] };
    if (request.op === "file.ignored") result = { entries: [] };
    if (request.op === "git.status") result = status(root);
    if (request.op === "git.diff")
      result = {
        hunks: [],
        patch: path
          ? patch(root, path)
          : [...base.keys()].map((path) => patch(root, path)).join(""),
      };
    if (request.op === "git.changeCounts")
      result = { all: 4, uncommitted: 4, staged: 1, unstaged: 3 };
    if (request.op === "git.log") result = { commits: [] };
    if (request.op === "turns.list") result = { turns: [] };
    if (request.op === "workspace.list") result = { workspaces };
    if (request.op === "workspace.archived") result = { workspaces: [] };
    if (request.op === "codeReview.list")
      result = { workspaceId: root, threads: [], partial: false };
    return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
  }
}
setActiveBridge(new FixtureBridge());
const scopes = Object.fromEntries(
  roots.map((root) => {
    const scope = defaultScopeFor(root);
    const tab = scope.tabs.find((tab) => tab.type === "files")!;
    return [
      root,
      {
        ...scope,
        activeId: tab.id,
        tabs: scope.tabs.map((item) =>
          item === tab
            ? {
                ...item,
                filePath: "sample.ts",
                title: "sample.ts",
                fileTreeVisible: true,
              }
            : item,
        ),
      },
    ];
  }),
);
useWorkspaceStore.setState({
  activeChatId: null,
  activePage: "workspace",
  newAgentFolder: roots[0],
  workbenchByScope: scopes,
});
Object.assign(window, {
  __fileEditor: {
    requests: () => requests,
    writes: () => writes,
    pending: () => pending.length,
    source: () => SOURCE,
    before: () => BEFORE,
    disk: (path = "sample.ts", root = roots[0]) => files.get(root)?.get(path),
    hold: () => {
      holdWrites = true;
    },
    fail: () => {
      failNext = true;
    },
    theme: (mode: "dark" | "light") => {
      toast.dismiss();
      setPrefs({ mode });
    },
    release: () => {
      holdWrites = false;
      for (const resolve of pending.splice(0)) resolve();
    },
    external: (path: string, content: string | null) => {
      const root = useWorkspaceStore.getState().newAgentFolder!;
      if (content === null) files.get(root)!.delete(path);
      else files.get(root)!.set(path, content);
      triggerGitRefresh(root);
    },
    open: (path: string) => {
      const state = useWorkspaceStore.getState(),
        root = state.newAgentFolder!;
      const scope = state.workbenchByScope[root];
      state.dispatch(
        buildDirectFileOpenAction(scope.tabs, path, {
          scope: root,
          preferredExistingTabId: scope.activeId,
          literalPath: true,
        }),
      );
    },
    switchOwner: () =>
      useWorkspaceStore.setState((state) => ({
        newAgentFolder: state.newAgentFolder === roots[0] ? roots[1] : roots[0],
      })),
    state: () => {
      const state = useWorkspaceStore.getState();
      return state.workbenchByScope[state.newAgentFolder!];
    },
  },
});

function Fixture() {
  const cwd = useWorkspaceStore((state) => state.newAgentFolder!);
  const state = useWorkspaceStore((value) => value.workbenchByScope[cwd]);
  return (
    <TooltipProvider>
      <ActionsCtx.Provider value={{} as never}>
        <DiffWorkerPoolProvider>
          <main
            data-zeros-root
            className="bg-bg1 text-fg1 flex h-screen min-w-0 flex-col"
          >
            <div className="h-10 shrink-0">
              <WorkbenchTabStrip
                tabs={state.tabs}
                activeId={state.activeId}
                folderKey={cwd}
                workspaceId={cwd}
              />
            </div>
            <div className="relative min-h-0 flex-1">
              {state.tabs
                .filter((tab) => tab.type === "files")
                .map((tab) => (
                  <div
                    key={`${cwd}:${tab.id}`}
                    hidden={tab.id !== state.activeId}
                    className="h-full"
                    {...(tab.id !== state.activeId ? { inert: "" } : {})}
                  >
                    <WorkbenchTabFrame
                      tab={tab}
                      folder={cwd}
                      active={tab.id === state.activeId}
                    >
                      <FilesTab
                        tab={tab}
                        active={tab.id === state.activeId}
                        scope={cwd}
                      />
                    </WorkbenchTabFrame>
                  </div>
                ))}
            </div>
            <Toaster />
          </main>
        </DiffWorkerPoolProvider>
      </ActionsCtx.Provider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
