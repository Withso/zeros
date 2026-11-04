// Real chat deck, transcript/composer, stores and caches. Only native/CP I/O
// and history content are synthetic; this fixture never admits a cloud VM.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatDeck } from "../shell/conversation/chat-deck";
import { usePanePortalsStore } from "../shell/conversation/pane-portal-store";
import { MAIN_PANE_ID } from "../state/chat-panes";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import type { AgentMessage } from "../features/agent/use-agent-session";
import { useWorkspaceStore } from "../state/workspace-store";
import { loadAgents } from "../features/agent/agents-cache";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";
import {
  acceptOrganizationSnapshot,
  getActiveOrganizationSnapshot,
} from "../features/team/team-store";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { PERSONAL_ORGANIZATION_ID } from "../features/team/personal-organization";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import { TooltipProvider } from "../shared/ui/primitives";
import {
  AuthContext,
  type AuthContextValue,
} from "../features/auth/auth-context";
import {
  turnRowCache,
  attachmentTextPreviewsCache,
} from "../state/read-caches";
import { LocalTranscriptCache } from "../state/local-transcript-cache";

const noop = () => {};
const params = new URLSearchParams(location.search);
const placement = params.get("placement") ?? "cloud";
const rows = Number(params.get("rows") ?? 200);
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder =
  placement === "cloud"
    ? cloudWorkspaceKey(target)
    : `/fixture/${placement}/repo`;
const localHistory = new LocalTranscriptCache();
const listeners = new Set<object>();
const calls: Record<string, number> = {};
const subscribe = () => {
  const token = {};
  listeners.add(token);
  return () => {
    listeners.delete(token);
  };
};
const agents = [
  {
    id: "codex",
    name: "Codex",
    installed: true,
    authenticated: true,
    version: "1",
    description: "",
    distribution: {},
  },
];
window.__ZEROS_NATIVE__ = { on: subscribe, invoke: async <T,>() => null as T };
setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  status: "connected",
  on: subscribe,
  onStatusChange: subscribe,
  send: noop,
  request: async (request: { type: string; op?: string }) => {
    const key = request.op ?? request.type;
    calls[key] = (calls[key] ?? 0) + 1;
    if (request.type === "AGENT_LIST_AGENTS")
      return { type: "AGENT_AGENTS_LIST", agents };
    return {
      type: "WORKSPACE_RESPONSE",
      op: request.op,
      result: request.op?.includes("list") ? [] : null,
    };
  },
} as unknown as RuntimeClient);
const organization = {
  id: target.organizationId,
  slug: "fixture",
  name: "Example",
  logo: null,
  isPersonal: placement === "local",
  role: "admin" as const,
  defaultTeamId: target.organizationId,
  workspaceCapabilities: { local: true, cloud: true },
  teamCapabilities: { multiple: false as const, canCreate: false as const },
};
acceptOrganizationSnapshot({
  user: {
    id: target.organizationId,
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: null,
  },
  organizations: [organization],
  teams: [organization],
});
setActiveOrganizationSelection(
  placement === "local" ? PERSONAL_ORGANIZATION_ID : target.organizationId,
  placement === "local",
);
acceptCloudWorkspaceDocument({
  id: target.workspaceId,
  organizationId: target.organizationId,
  teamId: target.organizationId,
  createdBy: target.organizationId,
  name: "Memory fixture",
  placement: "cloud",
  status: "ready",
  version: 1,
  error: null,
  deletedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "fixture",
    revision: "main",
  },
  generation: {
    number: 1,
    architecture: "linux/amd64",
    observedState: "running",
    lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
  },
});
const chats = Array.from({ length: 8 }, (_, i) => ({
  id:
    placement === "cloud"
      ? cloudScopedId(target, `memory-${i}`)
      : `${placement}-memory-${i}`,
  folder,
  agentId: "codex",
  agentName: "Codex",
  title: `Memory chat ${i}`,
  model: "gpt-6.1-sol",
  effort: "high" as const,
  permissionMode: "auto" as const,
  createdAt: i + 1,
  updatedAt: i + 1,
}));
function messages(id: string, revision = 0, count = rows): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${id}-row-${i}`,
    kind: "text",
    role: i % 2 ? "agent" : "user",
    text:
      i % 2
        ? `Revision ${revision}, response ${i}.\n\n${"Measured synthetic transcript content. ".repeat(24)}\n\n\`\`\`ts\nconst value = ${i};\n\`\`\``
        : `Prompt ${i}: explain the change for ${id}.`,
    createdAt: i + 1,
  }));
}
function prepareSessions() {
  useWorkspaceStore.setState({
    chats,
    activeChatId: chats[0].id,
    activePage: "workspace",
    newAgentFolder: folder,
  });
  for (const chat of chats)
    useSessionsStore.getState().setSession(chat.id, {
      ...BLANK,
      agentId: "codex",
      agentName: "Codex",
      cwd: folder,
      status: "ready",
      sessionId: chat.id,
      executionId: chat.id,
      transcriptState: "resident",
      hasTranscript: true,
      messages: messages(chat.id),
    });
}
const actions = {
  getSession: (id: string) => useSessionsStore.getState().sessions[id],
  getSendGeneration: () => 0,
  listAgents: async () => agents,
  hydrateChat: async () => {},
  ensureSession: async () => {},
  updateConfig: noop,
  holdQueue: noop,
  releaseQueue: noop,
  cancel: noop,
  stopBackgroundTask: noop,
  setRetainedChatIds: (ids: readonly string[]) => {
    // All fixture work is settled; production store eviction keeps the shell.
    for (const id of Object.keys(useSessionsStore.getState().sessions))
      if (!ids.includes(id)) useSessionsStore.getState().evictTranscript(id);
  },
} as unknown as SessionsActions;
await loadAgents(actions.listAgents);
const auth = {
  status: "unauthenticated",
  session: null,
  userId: null,
  email: null,
  oauthError: null,
  clearOAuthError: noop,
  cancelPendingOAuth: noop,
  startBrowserSignIn: async () => ({ ok: false }),
  signOut: async () => {},
  signOutEverywhere: async () => {},
  accounts: [],
  refreshAccounts: async () => {},
  switchAccount: async () => "unavailable" as const,
  signOutAccount: async () => {},
} as AuthContextValue;
function Harness() {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    usePanePortalsStore
      .getState()
      .setSlot(MAIN_PANE_ID, { host: host.current, activeChatId: chats[0].id });
    return () => usePanePortalsStore.setState({ panes: {} });
  }, []);
  return (
    <AuthContext.Provider value={auth}>
      <ActionsCtx.Provider value={actions}>
        <TooltipProvider>
          <main
            className="bg-bg1 text-fg1 relative flex h-screen min-h-0 min-w-0 flex-col"
            ref={host}
          />
          <ChatDeck />
        </TooltipProvider>
      </ActionsCtx.Provider>
    </AuthContext.Provider>
  );
}
let root: Root | null = null;
function mount() {
  if (root) return;
  prepareSessions();
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(<Harness />));
}
if (params.get("mount") !== "0") mount();
let finishQuery: (() => void) | undefined;
let heldQuery: Promise<unknown> | undefined;
Object.assign(window, {
  rendererMemoryFixture: {
    mount,
    select(index: number) {
      const chat = chats[index];
      flushSync(() => {
        const slot = useSessionsStore.getState().sessions[chat.id];
        if (slot.transcriptState === "cold")
          useSessionsStore.getState().patchSession(chat.id, {
            messages: messages(chat.id),
            transcriptState: "resident",
          });
        useWorkspaceStore.setState({
          activeChatId: chat.id,
          activePage: "workspace",
        });
        usePanePortalsStore
          .getState()
          .setSlot(MAIN_PANE_ID, { activeChatId: chat.id });
      });
    },
    replace(index: number, revision: number) {
      const chat = chats[index];
      flushSync(() =>
        useSessionsStore.getState().patchSession(chat.id, {
          messages: messages(chat.id, revision),
          transcriptState: "resident",
        }),
      );
    },
    hide(hidden: boolean) {
      flushSync(() =>
        useWorkspaceStore.setState({
          activePage: hidden ? "dashboard" : "workspace",
        }),
      );
    },
    holdQuery() {
      heldQuery = attachmentTextPreviewsCache.load(
        "fixture-held-read",
        () =>
          new Promise<string>((resolve) => {
            finishQuery = () => resolve("completed read");
          }),
      );
    },
    async finishQuery() {
      finishQuery?.();
      await heldQuery;
      heldQuery = undefined;
      finishQuery = undefined;
    },
    async churnHistory(round: number) {
      for (let i = 0; i < 96; i++) {
        const chatId = `history-${round}-${i}`,
          content = messages(chatId);
        // Cloud chats keep no renderer-side history cache.
        if (placement !== "cloud")
          localHistory.remember(chatId, folder, {
            messages: content,
            leadingPrompt: null,
          });
      }
      if (placement !== "cloud") await localHistory.flush();
    },
    churnQueries(round: number) {
      for (let i = 0; i < 1024; i++) {
        turnRowCache.setData(`${placement}-${round}-${i}`, null);
        attachmentTextPreviewsCache.setData(
          `${placement}-${round}-${i}`,
          Array.from(
            { length: 1024 },
            (_, part) => `Preview ${round}:${i}:${part}: synthetic fixture`,
          ).join("\n"),
        );
      }
    },
    unmount() {
      flushSync(() => root?.unmount());
      root = null;
      useSessionsStore.getState().clearAll();
      localHistory.releaseMemory();
    },
    stats() {
      const slots = Object.values(useSessionsStore.getState().sessions);
      return {
        placement,
        rows,
        ownerIsPersonal: getActiveOrganizationSnapshot()?.isPersonal,
        historyEntries: placement === "cloud" ? 0 : localHistory.memoryStats().entries,
        historyBytes: placement === "cloud" ? 0 : localHistory.memoryStats().bytes,
        historyTokens: 0,
        chats: slots.length,
        resident: slots.filter((s) => s.messages.length > 0).length,
        messages: slots.reduce((n, s) => n + s.messages.length, 0),
        nativeListeners: listeners.size,
        nativeCalls: { ...calls },
        turnCache: turnRowCache.keys().length,
        textCache: attachmentTextPreviewsCache.keys().length,
        textBytes: attachmentTextPreviewsCache
          .keys()
          .reduce(
            (bytes, key) =>
              bytes +
              (attachmentTextPreviewsCache.peekSnapshot(key).data?.length ??
                0) *
                2,
            0,
          ),
        dom: document.querySelectorAll("*").length,
        surfaces: document.querySelectorAll(".zeros-agent-surface").length,
        hiddenLayers: document.querySelectorAll("[data-zeros-root][inert]")
          .length,
        turns: document.querySelectorAll("[data-checkpoint-id]").length,
      };
    },
  },
});
