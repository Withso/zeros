// Real footer, Changes surface and navigation; only native I/O is a fixture.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { TurnInfo } from "../platform/turns";
import type { Workspace } from "../platform/git";
import type { BridgeMessage } from "../platform/bridge/messages";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import { cloudScopedId, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../state/store";
import { setWorkspaceRowsForTesting } from "../state/use-projects";
import { turnRowCache, turnRowKey } from "../state/read-caches";
import { defaultScopeFor } from "../shell/workbench/tab-model";
import { ChangesSurface } from "../shell/workbench/tabs/changes-surface";
import { getChangesFilter } from "../shell/workbench/tabs/changes-filter-store";
import { DiffWorkerPoolProvider } from "../shell/workbench/diff-worker-pool";
import { TurnFooter } from "../features/agent/turn-footer";
import { ActionsCtx } from "../features/agent/sessions-context";
import { Button, TooltipProvider } from "../shared/ui/primitives";

const params = new URLSearchParams(location.search);
const owner = params.get("owner") ?? "personal";
const root = owner === "cloud" ? "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" : `/${owner}/project`;
const agentId = params.get("agent") ?? "claude";
const count = Number(params.get("count") ?? 20);
const target = parseCloudWorkspaceKey(root);
const chatId = target ? cloudScopedId(target, "chat") : "chat";
const names = ["tokyo.md", "paris.md", "cairo.md", "rio-de-janeiro.md", "mumbai.md", "nairobi.md", "sydney.md", "mexico-city.md", "istanbul.md", "kyoto.md", "cape-town.md", "buenos-aires.md", "seoul.md", "marrakech.md", "lisbon.md", "vancouver.md", "singapore.md", "reykjavik.md", "new-orleans.md", "prague-with-a-very-long-filename-that-still-leaves-the-counts-readable.md"];
const turn: TurnInfo = { chatId, turnId: "opening", folder: root, workspaceId: root, agentId,
  ord: 1, summary: "Write the city notes", startedAt: 1_000, endedAt: 1_850_000, status: "completed", stopReason: "end_turn",
  preSnapshot: "pre", postSnapshot: "post", files: names.slice(0, count).map((name, index) => ({
    path: `docs/${name}`, status: index === 2 ? "modified" : "added", additions: 19, deletions: index === 2 ? 2 : 0,
  })) };
const nextTurn = { ...turn, turnId: "new-opening", ord: 2 };
const latest = { ...turn, turnId: "latest", ord: 3, startedAt: turn.endedAt! + 1, summary: "A later, unrelated turn",
  files: [{ path: "later.ts", status: "added" as const, additions: 1, deletions: 0 }] };
const workspace = { id: root, path: root, repoRoot: root, repoSlug: "turn-fixture", baseBranch: "main" } as Workspace;
setWorkspaceRowsForTesting(workspace.repoSlug, [workspace]);
const requests: { op?: string; params?: Record<string, unknown> }[] = [];
const patchFor = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
const noop = () => {};

class FixtureBridge extends WorkspaceRuntimeClient {
  constructor() { super({ open: async () => { throw new Error("Unexpected wake"); }, workspaces: () => [{ ...workspace }] }); }
  override get status() { return "connected" as const; }
  override statusForWorkspace() { return "connected" as const; }
  override onWorkspaceStatusChange(_folder: string, callback: () => void) { callback(); return noop; }
  override async request<T extends BridgeMessage = BridgeMessage>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
    const request = message as { op?: string; params?: Record<string, unknown> };
    requests.push(request);
    let result: unknown = {};
    const record = request.params?.turnId === nextTurn.turnId ? nextTurn : turn;
    if (request.op === "turns.get") result = { turn: record };
    if (request.op === "turns.list") result = { turns: [latest, nextTurn, turn] };
    if (request.op === "turns.diff") result = { patch: patchFor(String(request.params?.path ?? turn.files[0]?.path)) };
    if (request.op === "git.diff") {
      const files = request.params?.filePath ? turn.files.filter(file => file.path === request.params?.filePath) : turn.files;
      result = { hunks: [], patch: files.map(file => patchFor(file.path)).join(""), files };
    }
    if (request.op === "git.status") result = { staged: [], unstaged: [], untracked: [], conflicted: [], conflictState: null };
    if (request.op === "git.changeCounts") result = { all: 1, uncommitted: 1, staged: 0, unstaged: 1 };
    if (request.op === "git.log") result = { commits: [] };
    if (request.op === "workspace.list") result = { workspaces: [workspace] };
    if (request.op === "codeReview.list") result = { workspaceId: root, threads: [], partial: false };
    return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
  }
}
setActiveBridge(new FixtureBridge());
for (const record of [turn, nextTurn]) turnRowCache.setData(turnRowKey(chatId, record.turnId), record);
const initial = defaultScopeFor(root);
useWorkspaceStore.setState({ activeChatId: null, activePage: "workspace", newAgentFolder: root,
  workbenchByScope: { [root]: { ...initial, activeId: initial.tabs.find(tab => tab.type === "files")!.id } } });
Object.assign(window, { __turnChanges: {
  state: () => useWorkspaceStore.getState().workbenchByScope[root],
  filter: () => getChangesFilter(root), requests: () => requests,
} });

function Fixture() {
  const [switched, setSwitched] = useState(false);
  const record = switched ? nextTurn : turn;
  const state = useWorkspaceStore(value => value.workbenchByScope[root]);
  const changes = state.tabs.find(tab => tab.type === "changes")!;
  const reviewing = state.activeId === changes.id;
  return <TooltipProvider><ActionsCtx.Provider value={{} as never}><DiffWorkerPoolProvider>
    <div data-zeros-root className="bg-bg1 text-fg1 flex h-screen min-w-0 flex-col">
      <div className="border-border1 flex gap-2 border-b p-2">
        <Button variant="ghost" onClick={() => setSwitched(value => !value)}>Switch turn</Button>
        <span className="text-fg3 self-center text-xs">{owner} · {agentId}</span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div data-footer-fixture className="w-full max-w-[720px] min-w-0 shrink-0 self-start p-6">
          <p className="mb-4 text-sm">The city notes are ready to review.</p>
          <TurnFooter chatId={chatId} turnId={record.turnId} folder={root} recordedSummary={target ? record : undefined}
            events={[{ id: "answer", kind: "text", role: "agent", text: "The city notes are ready to review.", createdAt: record.endedAt! }]}
            startedAt={record.startedAt} live={false} onFork={noop} />
        </div>
        {reviewing && <div data-review-fixture className="border-border1 min-w-0 flex-1 border-l">
          <ChangesSurface tab={changes} active scope={root} cwd={root} workspaceId={root} folder={root} baseBranch="main" refreshKey={0} onChanged={noop} retryReview={async () => {}} />
        </div>}
      </div>
    </div>
  </DiffWorkerPoolProvider></ActionsCtx.Provider></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
