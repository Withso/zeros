// Production AgentChat empty state in Local/cloud; synthetic engine whose
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
import { cloudScopedId, cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";

// One localStorage epoch per test run: a reload inside the run is an app
// restart that keeps persisted state; a new run starts clean.
const epochKey = "fixture:transcript-row-epoch";
if (!sessionStorage.getItem(epochKey)) {
  localStorage.clear();
  sessionStorage.setItem(epochKey, String(Date.now()));
}
const repo = { id: "example", name: "Example", repoRoot: "/fixture/example", repoSlug: "example", originUrl: null, addedAt: 1 };
localStorage.setItem("zeros-projects-v1", JSON.stringify([repo]));
const params = new URLSearchParams(location.search), cloud = params.has("cloud");
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloud ? cloudWorkspaceKey(target) : "/Users/dev/zeros/workspaces/example/amber";
const fixturePrefix = cloud ? "fixture:cloud-summary" : "fixture:summary";
const delayKey = cloud ? "fixture:cloud-summaries-delay" : "fixture:summaries-delay";
const chatId = (id: string) => cloud ? cloudScopedId(target, id) : id;
const workspace: Workspace = {
  id: "amber", branch: "dev/Amber", repoRoot: repo.repoRoot, repoSlug: repo.repoSlug, path: folder, baseBranch: "main",
  status: "in-progress", createdAt: 1, archivedAt: null, stashRef: null, archiveSnapshot: null, prNumber: null,
  prState: null, prUrl: null, agentId: null, lastActiveAt: null, present: true,
} as Workspace;

const fixture = {
  /** The engine's transcript-list answer waits this long. */
  summariesDelayMs: Number(sessionStorage.getItem(delayKey) ?? (cloud ? 3_000 : 0)),
  /** The engine's chats; they survive a reload like the engine database. */
  rows: JSON.parse(sessionStorage.getItem(`${fixturePrefix}-rows`) ?? "[]") as ChatSummaryWire[],
  folder,
  senderId: chatId("chat-sender"),
  failSummaries: false,
  holdSummaries: params.has("hold"),
  summaryReleases: [] as Array<() => void>,
  holdTranscript: params.has("focus-races"),
  transcriptReleases: [] as Array<() => void>,
  graceTimers: 0,
  createdCommits: 0,
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
    sessionStorage.setItem(`${fixturePrefix}-rows`, JSON.stringify(rows));
  },
  setDelay(ms: number) {
    this.summariesDelayMs = ms;
    sessionStorage.setItem(delayKey, String(ms));
  },
  emit(type: string, message: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  },
};
Object.assign(window, { transcriptRowFixture: fixture });
if (params.has("focus-races")) {
  // Each focus case starts with an empty destination, not the attachment draft
  // persisted by the preceding case. The ordinary restart fixture keeps it.
  localStorage.removeItem("zeros:composer-drafts:v1");
  fixture.summariesDelayMs = 0;
  fixture.setRows([{ chatId: fixture.senderId, folder, title: "Cold focus", summary: "Read this chat",
    summaryAt: 1, agentId: "codex", agentName: "Codex", userMessageCount: 1, lastMessageAt: 1 }]);
}
if (cloud) {
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 400) fixture.graceTimers++;
    return timeout(handler, delay, ...args);
  }) as typeof window.setTimeout;
}
window.__ZEROS_NATIVE__ = { on: () => () => {}, async invoke<T>(): Promise<T> { return null as T; } } as never;

const { setActiveBridge } = await import("../platform/bridge/active-bridge");
const agents = [{ id: "codex", name: "Codex", installed: true, authenticated: true, version: "1.0.0", description: "", distribution: {} }];
setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
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
    if (request.op === "messages.window" && params.has("focus-races")) {
      if (fixture.holdTranscript) await new Promise<void>(resolve => fixture.transcriptReleases.push(resolve));
      result = { messages: [
        { id: "prompt", kind: "text", role: "user", text: "Read this chat", createdAt: 1 },
        { id: "answer", kind: "text", role: "agent", text: "A completed answer", createdAt: 2 },
      ].map(message => ({ msgId: message.id, kind: message.kind, payload: JSON.stringify(message), createdAt: message.createdAt })) };
    }
    if (request.op === "messages.windowOlder") result = { messages: [] };
    if (request.op === "chats.summariesForFolder") {
      fixture.summaryReads += 1;
      if (fixture.firstReadAt === null) {
        fixture.firstReadAt = performance.now();
        fixture.rowAtFirstRead = !!document.querySelector('[data-chat-pane="chat-empty"]')?.textContent
          ?.includes("Add chat transcripts");
      }
      if (fixture.holdSummaries) await new Promise<void>(resolve => fixture.summaryReleases.push(resolve));
      if (fixture.summariesDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fixture.summariesDelayMs));
      fixture.summaryAnswers += 1;
      if (fixture.failSummaries) return { type: "WORKSPACE_ERROR", op: request.op, code: "CLOUD_V2_STOPPED", message: "Workspace stopped" };
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
const { Button, Input, TooltipProvider } = await import("../shared/ui/primitives");
const { deliverFilesToChat } = await import("../features/agent/composer-file-attachment-delivery");

if (cloud) {
  const { installAccountPresentationIdentity } = await import("../state/account-presentation");
  const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
  const { acceptCloudWorkspaceDocument } = await import("../state/cloud-workspace-catalog");
  installAccountPresentationIdentity({ sub: target.organizationId, email: "fixture@example.test", name: "Fixture", provider: "workos" });
  const organization = { id: target.organizationId, slug: "fixture", name: "Example organization", logo: null,
    isPersonal: false, role: "admin" as const, defaultTeamId: target.organizationId,
    workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
  acceptOrganizationSnapshot({ user: { id: target.organizationId, email: "fixture@example.test", displayName: "Fixture", staffRole: null },
    organizations: [organization], teams: [organization] });
  acceptCloudWorkspaceDocument({ id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
    createdBy: target.organizationId, name: "Transcript fixture", placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
    createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z",
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
    generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "running", lastObservedAt: null },
  });
}

const names = cloud ? ["chat-sender", "chat-empty", "chat-empty-b"] : ["chat-sender", "chat-empty"];
const chats = names.map((id) => ({ id: chatId(id), folder, agentId: "codex", agentName: "Codex", title: "Untitled",
  model: "gpt-6.1-sol", effort: "high" as const, permissionMode: "auto" as const, createdAt: 1, updatedAt: 1 }));
useWorkspaceStore.setState({ chats, activeChatId: chatId("chat-empty"), activePage: "workspace" });
for (const chat of chats) useSessionsStore.getState().setSession(chat.id, { ...BLANK, agentId: "codex", agentName: "Codex",
  cwd: folder, status: "ready", transcriptState: "resident" });
if (cloud && params.has("resident")) useSessionsStore.getState().patchSession(chatId("chat-sender"), {
  messages: [{ id: "first-prompt", kind: "text", role: "user", text: "Research the cloud workspace", createdAt: 1 }],
});

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
if (cloud) await (await import("../features/agent/workspace-agent-registry")).warmCloudAgentRegistry(folder);

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
          {(cloud ? ["Sender", "Empty A", "Empty B"] : ["Sender", "Empty"]).map((label, index) => <Button key={label} onClick={() => {
            useWorkspaceStore.setState({ activeChatId: chats[index].id });
            setSelected(index);
          }}>{label}</Button>)}
          <Button onClick={() => setMount((value) => value + 1)}>Remount chat</Button>
          {params.has("focus-races") && <Input aria-label="Other editor" />}
          {params.has("focus-races") && <Button onClick={() => {
            const id = useWorkspaceStore.getState().activeChatId;
            if (id) deliverFilesToChat(id, { id: "live-focus", files: [new File(["Live delivery"], "live-focus.txt", { type: "text/plain" })] });
          }}>Deliver files</Button>}
        </nav>
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          {chats.map((chat, index) => <div key={chat.id} data-chat-pane={names[index]}
            data-pane-root={params.has("focus-races") ? "" : undefined}
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
  if (![...document.querySelectorAll('[data-chat-pane^="chat-empty"]')].some(pane => pane.textContent?.includes("Created"))) return;
  fixture.createdCommits++;
  fixture.workspaceRowsAt = performance.now();
  if (!cloud) observer.disconnect();
}).observe(document.body, { childList: true, subtree: true, characterData: true });
createRoot(document.getElementById("root")!).render(<Harness />);
