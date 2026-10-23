// Real tool controls, Changes model, navigation store and file viewer. Only the
// bridge transport is a fixture; held Git reads exercise the cold fallback.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { BridgeMessage } from "../platform/bridge/messages";
import type { Workspace } from "../platform/git";
import { relativeWorkspaceFilePath } from "../platform/workspace-file-path";
import { useWorkspaceStore } from "../state/workspace-store";
import { setWorkspaceRowsForTesting } from "../state/use-projects";
import { defaultScopeFor } from "../shell/workbench/tab-model";
import {
  ChangesSurface,
  ChangesWorkbenchSurface,
} from "../shell/workbench/tabs/changes-surface";
import { FileViewer } from "../shell/workbench/tabs/file-viewer";
import { DiffWorkerPoolProvider } from "../shell/workbench/diff-worker-pool";
import { EventRow } from "../features/agent/renderers/event-row";
import { EditCard } from "../features/agent/renderers/tool-edit";
import type { RendererContext } from "../features/agent/renderers/types";
import type { AgentToolMessage } from "../features/agent/use-agent-session";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Button } from "../shared/ui/primitives";

const cloud =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const params = new URLSearchParams(location.search);
const owner = params.get("owner") ?? "personal";
const root = owner === "cloud" ? cloud : `/${owner}/project`;
const cwd = params.has("nested") ? `${root}/packages/app` : root;
const prefix = params.has("nested") ? "packages/app/" : "";
const changedPath = `${prefix}src/changed.ts`;
const patch = `diff --git a/${changedPath} b/${changedPath}\n--- a/${changedPath}\n+++ b/${changedPath}\n@@ -1 +1 @@\n-before\n+after\n`;
const renamedPath = `${prefix}src/renamed.ts`;
const renamePatch = `diff --git a/${prefix}src/before.ts b/${renamedPath}\nsimilarity index 100%\nrename from ${prefix}src/before.ts\nrename to ${renamedPath}\n`;
const workspace = {
  id: root,
  path: root,
  repoRoot: root,
  repoSlug: "pill-fixture",
  baseBranch: "main",
} as Workspace;
setWorkspaceRowsForTesting(workspace.repoSlug, [workspace]);
let held = params.has("hold");
const fail = params.has("fail");
let gitFailures = 0;
let settledReads = 0;
const pending: (() => void)[] = [];
const requests: unknown[] = [];
const noop = () => {};

class FixtureBridge extends WorkspaceRuntimeClient {
  constructor() {
    super({
      open: async () => {
        throw new Error("Fixture only");
      },
      workspaces: () => [{ ...workspace }],
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
  override fileReferencePath(folder: string, path: string) {
    return relativeWorkspaceFilePath(
      folder,
      path,
      "/home/user/example/project",
    );
  }
  override async request<T extends BridgeMessage = BridgeMessage>(
    message: Partial<BridgeMessage> & { type: string },
  ): Promise<T> {
    const request = message as {
      op?: string;
      params?: { path?: string; filePath?: string; workspaceId?: string };
    };
    requests.push(request);
    let result: unknown = {};
    if (request.op === "git.diff") {
      if (!request.params?.filePath && held)
        await new Promise<void>((resolve) => pending.push(resolve));
      if (fail) {
        gitFailures++;
        throw new Error("Fixture Git unavailable");
      }
      if (!request.params?.filePath) settledReads++;
      result = {
        hunks: [],
        patch: !request.params?.filePath
          ? patch + renamePatch
          : request.params.filePath === changedPath
            ? patch
            : request.params.filePath === renamedPath
              ? renamePatch
              : "",
      };
    }
    if (request.op === "git.status")
      result = {
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        conflictState: null,
      };
    if (request.op === "git.changeCounts")
      result = { all: 2, uncommitted: 2, staged: 0, unstaged: 2 };
    if (request.op === "git.log" || request.op === "turns.list") result = [];
    if (request.op === "workspace.list") result = [workspace];
    if (request.op === "file.read") {
      const path = request.params?.path ?? "";
      result = path.endsWith(".svg")
        ? {
            kind: "image",
            path,
            bytes: 100,
            dataUrl: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>')}`,
          }
        : {
            kind: "text",
            path,
            bytes: 30,
            content: `Saved source for ${path}\n`,
          };
    }
    if (request.op === "codeReview.list")
      result = {
        workspaceId: request.params?.workspaceId ?? root,
        threads: [],
        partial: false,
      };
    return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
  }
}
setActiveBridge(new FixtureBridge());
const initial = defaultScopeFor(cwd);
useWorkspaceStore.setState({
  activeChatId: null,
  newAgentFolder: cwd,
  workbenchByScope: {
    [cwd]: {
      ...initial,
      activeId: initial.tabs.find((tab) => tab.type === "files")!.id,
    },
  },
});
Object.assign(window, {
  __filePillFixture: {
    state: () => useWorkspaceStore.getState().workbenchByScope[cwd],
    requests: () => requests,
    pending: () => pending.length,
    release: () => {
      held = false;
      for (const resolve of pending.splice(0)) resolve();
    },
    failures: () => gitFailures,
    settled: () => settledReads,
  },
});

const ctx = {
  attachmentCwd: cwd,
  attachmentImagesActive: true,
  editBaselines: new Map(),
} as RendererContext;
const rows = [
  ["read", ".context/task/notes.ts"],
  ["read", ".context/Shot ü #1.svg"],
  ["edit", ".context/task/notes.ts"],
  ["edit", "src/unchanged.ts"],
  ["edit", "src/changed.ts"],
  ["edit", "src/before.ts"],
] as const;
function Fixture() {
  const state = useWorkspaceStore((value) => value.workbenchByScope[cwd]);
  const active = state.tabs.find((tab) => tab.id === state.activeId)!;
  const changes = state.tabs.find((tab) => tab.type === "changes")!;
  return (
    <TooltipProvider>
      <DiffWorkerPoolProvider>
        <div data-zeros-root="" className="bg-bg1 text-fg1 flex h-screen">
          <div className="border-border1 w-96 shrink-0 space-y-4 border-r p-4">
            <p>Tool files · {owner}</p>
            {rows.map(([kind, path], index) => {
              const message: AgentToolMessage = {
                id: `tool-${index}`,
                kind: "tool",
                toolCallId: `tool-${index}`,
                title: kind,
                toolKind: kind,
                status: "completed",
                createdAt: 1,
                updatedAt: 2,
                rawInput: {
                  file_path: path,
                  old_string: "before",
                  new_string: "after",
                },
              };
              return (
                <div key={index} data-pill-kind={kind} data-pill-path={path}>
                  {kind === "edit" ? (
                    <EditCard message={message} ctx={ctx} />
                  ) : (
                    <EventRow
                      message={message}
                      ctx={ctx}
                      detail={<pre>Read source</pre>}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-border1 flex gap-2 border-b p-2">
              {state.tabs
                .filter(
                  (tab) =>
                    tab.type === "changes" ||
                    (tab.type === "files" && tab.filePath),
                )
                .map((tab) => (
                  <Button
                    key={tab.id}
                    variant="ghost"
                    onClick={() =>
                      useWorkspaceStore.getState().dispatch({
                        type: "ACTIVATE_WORKBENCH_TAB",
                        scope: cwd,
                        id: tab.id,
                      })
                    }
                  >
                    {tab.title}
                  </Button>
                ))}
            </div>
            <output data-open-file="" data-open-type={active.type}>
              {active.filePath ?? ""}
            </output>
            <div className="min-h-0 flex-1" hidden={active.type !== "changes"}>
              {params.has("plain") ? (
                <ChangesWorkbenchSurface
                  tab={changes}
                  active={active.type === "changes"}
                  scope={cwd}
                />
              ) : (
                <ChangesSurface
                  tab={changes}
                  active={active.type === "changes"}
                  scope={cwd}
                  cwd={cwd}
                  workspaceId={root}
                  folder={root}
                  baseBranch="main"
                  refreshKey={0}
                  onChanged={noop}
                  retryReview={async () => {}}
                />
              )}
            </div>
            {active.type === "files" && active.filePath && (
              <div data-file-viewer="" className="min-h-0 flex-1">
                <FileViewer
                  key={active.id}
                  tabId={active.id}
                  active
                  cwd={cwd}
                  path={active.filePath}
                  workspaceId={root}
                  diff={active.diff}
                  diffScope={active.diffScope}
                  viewerMode={active.viewerMode}
                  contentRevision={active.contentRevision}
                  refreshKey={0}
                />
              </div>
            )}
          </div>
        </div>
      </DiffWorkerPoolProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
