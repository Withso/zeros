// Production AgentChat empty state in a Local workspace; synthetic engine whose
// transcript-list answer can be held open, to prove the row never waits blank.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { Workspace } from "../platform/git";
import type { ChatSummaryWire } from "../features/agent/agent-history-client";
import type { SessionsActions } from "../features/agent/sessions-context";

// One localStorage epoch per test run: a reload inside the run is an app
// restart that keeps persisted state; a new run starts clean.
const epochKey = "fixture:transcript-row-epoch";
if (!sessionStorage.getItem(epochKey)) {
  localStorage.clear();
  sessionStorage.setItem(epochKey, String(Date.now()));
}
const repo = { id: "example", name: "Example", repoRoot: "/fixture/example", repoSlug: "example", originUrl: null, addedAt: 1 };
localStorage.setItem("zeros-projects-v1", JSON.stringify([repo]));
const folder = "/Users/dev/zeros/workspaces/example/amber";
const workspace: Workspace = {
  id: "amber", branch: "dev/Amber", repoRoot: repo.repoRoot, repoSlug: repo.repoSlug, path: folder, baseBranch: "main",
  status: "in-progress", createdAt: 1, archivedAt: null, stashRef: null, archiveSnapshot: null, prNumber: null,
  prState: null, prUrl: null, agentId: null, lastActiveAt: null, present: true,
} as Workspace;

const fixture = {
  /** The engine's transcript-list answer waits this long. */
  summariesDelayMs: Number(sessionStorage.getItem("fixture:summaries-delay") ?? 0),
  /** The engine's chats; they survive a reload like the engine database. */
  rows: JSON.parse(sessionStorage.getItem("fixture:summary-rows") ?? "[]") as ChatSummaryWire[],
  summaryReads: 0,
  summaryAnswers: 0,
  /** performance.now() of the first list request (the empty chat's mount)
   *  and of the first frame its workspace rows were in the DOM. */
  firstReadAt: null as number | null,
  workspaceRowsAt: null as number | null,
  /** The transcript row was already on screen when the first list request
   *  left (a restart painting the persisted list). */
  rowAtFirstRead: false,
  listeners: new Map<string, Set<(message: unknown) => void>>(),
  setRows(rows: ChatSummaryWire[]) {
    this.rows = rows;
    sessionStorage.setItem("fixture:summary-rows", JSON.stringify(rows));
  },
  setDelay(ms: number) {
    this.summariesDelayMs = ms;
    sessionStorage.setItem("fixture:summaries-delay", String(ms));
  },
  emit(type: string, message: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  },
};
Object.assign(window, { transcriptRowFixture: fixture });
window.__ZEROS_NATIVE__ = { on: () => () => {}, async invoke<T>(): Promise<T> { return null as T; } } as never;

const { setActiveBridge } = await import("../platform/bridge/active-bridge");
const agents = [{ id: "codex", name: "Codex", installed: true, authenticated: true, version: "1.0.0", description: "", distribution: {} }];
setActiveBridge({
  status: "connected", onStatusChange: () => () => {}, forceReconnect: async () => {},
  on: (type: string, listener: (message: unknown) => void) => {
    const listeners = fixture.listeners.get(type) ?? new Set();
    fixture.listeners.set(type, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  request: async (request: { type: string; op?: string; params?: Record<string, unknown> }) => {
    if (request.type === "AGENT_LIST_AGENTS") return { type: "AGENT_AGENTS_LIST", agents };
    let result: unknown = {};
    if (request.op === "project.list") result = { projects: [repo] };
    if (request.op === "workspace.list") result = { workspaces: request.params?.archived === true ? [] : [workspace] };
    if (request.op === "chats.summariesForFolder") {
      fixture.summaryReads += 1;
      if (fixture.firstReadAt === null) {
        fixture.firstReadAt = performance.now();
        fixture.rowAtFirstRead = !!document.querySelector('[data-chat-pane="chat-empty"]')?.textContent
          ?.includes("Add chat transcripts");
      }
      if (fixture.summariesDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fixture.summariesDelayMs));
      fixture.summaryAnswers += 1;
      result = { summaries: fixture.rows.filter((row) => row.folder === request.params?.folder &&
        row.chatId !== request.params?.excludeChatId) };
    }
    return { type: "WORKSPACE_RESPONSE", op: request.op, result };
  },
} as unknown as RuntimeClient);

const { AgentChat } = await import("../features/agent/agent-chat");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { useChatSession } = await import("../features/agent/sessions-hooks");
const { BLANK, useSessionsStore } = await import("../features/agent/sessions-store");
const { loadAgents } = await import("../features/agent/agents-cache");
const { useWorkspaceStore } = await import("../state/workspace-store");
const { Button, TooltipProvider } = await import("../shared/ui/primitives");

const chats = ["chat-sender", "chat-empty"].map((id) => ({ id, folder, agentId: "codex", agentName: "Codex", title: "Untitled",
  model: "gpt-6.1-sol", effort: "high" as const, permissionMode: "auto" as const, createdAt: 1, updatedAt: 1 }));
useWorkspaceStore.setState({ chats, activeChatId: "chat-empty", activePage: "workspace" });
for (const chat of chats) useSessionsStore.getState().setSession(chat.id, { ...BLANK, agentId: "codex", agentName: "Codex",
  cwd: folder, status: "ready", transcriptState: "resident" });

const actions = {
  getSession: (chatId: string) => useSessionsStore.getState().sessions[chatId],
  getSendGeneration: () => 0,
  prepareForSend: () => null,
  listAgents: async () => agents,
  hydrateChat: async () => {},
  ensureSession: async () => {},
  updateConfig: () => {},
  holdQueue: () => {}, releaseQueue: () => {},
} satisfies Partial<SessionsActions>;
await loadAgents(actions.listAgents);

function Chat({ id, active }: { id: string; active: boolean }) {
  const session = useChatSession(id);
  return <AgentChat chatId={id} session={session} surfaceActive={active} onBack={() => {}} />;
}
function Harness() {
  const [selected, setSelected] = useState(1);
  const [mount, setMount] = useState(0);
  return <ActionsCtx.Provider value={actions as unknown as SessionsActions}>
    <TooltipProvider delayDuration={100}>
      <main className="bg-bg1 text-fg1 flex h-screen flex-col">
        <nav className="flex gap-2 p-4">
          {["Sender", "Empty"].map((label, index) => <Button key={label} onClick={() => {
            useWorkspaceStore.setState({ activeChatId: chats[index].id });
            setSelected(index);
          }}>{label}</Button>)}
          <Button onClick={() => setMount((value) => value + 1)}>Remount chat</Button>
        </nav>
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          {chats.map((chat, index) => <div key={chat.id} data-chat-pane={chat.id}
            className={selected === index ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            {...(selected === index ? {} : { inert: "" })}>
            <Chat key={mount} id={chat.id} active={selected === index} />
          </div>)}
        </div>
      </main>
    </TooltipProvider>
  </ActionsCtx.Provider>;
}
new MutationObserver((_, observer) => {
  if (!document.querySelector('[data-chat-pane="chat-empty"]')?.textContent?.includes("Created")) return;
  fixture.workspaceRowsAt = performance.now();
  observer.disconnect();
}).observe(document.body, { childList: true, subtree: true, characterData: true });
createRoot(document.getElementById("root")!).render(<Harness />);
