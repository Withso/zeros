// Real PR controls and session provider; only the engine transport is faked.
// No ChatView mounts here: a PR click must also work before chat admission.
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "/styles/zeros-tokens.css";
import "/styles/semantic-tokens.css";
import "/styles/globals.css";
import { AgentSessionsProvider } from "../features/agent/sessions-provider";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import { useSessionsStore } from "../features/agent/sessions-store";
import type { AgentTextMessage } from "../features/agent/use-agent-session";
import { registerAgentPreferencesFlush } from "../platform/agent-preferences";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import type { Workspace } from "../platform/git";
import { useWorkspaceStore } from "../state/workspace-store";
import type { ChatThread } from "../state/store";
import { CreatePrButton } from "../shell/pr/create-pr-button";
import { PrStatusIsland } from "../shell/pr/pr-status-island";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Toaster } from "../shared/ui/primitives/elements/toast";

const params = new URLSearchParams(location.search);
const workspace: Workspace = {
  id: "pr-fixture",
  path: params.get("workspacePath") ?? "/pr-fixture",
  repoRoot: "/pr-fixture",
  repoSlug: "fixture",
  branch: "feature",
  baseBranch: "main",
  status: "in-progress",
  createdAt: 1,
  archivedAt: null,
  stashRef: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: null,
  prNumber: params.get("action") === "resolve" ? 9 : null,
  prState: "ready",
};
const chat: ChatThread = {
  id: "chat-a",
  folder: params.get("chatFolder") ?? workspace.path,
  kind: params.get("terminal") ? "terminal" : "chat",
  agentId: "codex",
  agentName: "Codex",
  model: "gpt-5.4",
  effort: "high",
  permissionMode: "auto",
  title: "Untitled",
  createdAt: 1,
  updatedAt: 1,
};
const otherChat = { ...chat, id: "chat-b", folder: "/other-workspace" };
const history: AgentTextMessage[] = params.get("history")
  ? [
      {
        id: "previous",
        kind: "text",
        role: "user",
        text: "Previous work",
        createdAt: 1,
      },
    ]
  : [];
useWorkspaceStore.setState({
  chats: [chat, otherChat],
  activeChatId: chat.id,
  newAgentFolder: workspace.path,
});
useSessionsStore.setState({ sessions: {} });

type Request = {
  type: string;
  op?: string;
  params?: Record<string, unknown>;
  agentId?: string;
  chatId?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionId?: string;
  executionId?: string;
  promptId?: string;
  userMessageId?: string;
  adoptOnly?: boolean;
  prompt?: { type: string; text?: string }[];
  bubble?: { displayText?: string; autoAction?: string };
};
const requests: Request[] = [];
const historyReads: (() => void)[] = [];
const promptTranscripts: string[][] = [];
let historyReadsToHold = 0;
let sessionActions: ReturnType<typeof useAgentSessions> | null = null;
let connected = true;
const clients = new Set<RuntimeClient>();
let runningPrompt: Request | null = null;
let rejectPrompt: ((error: Error) => void) | undefined;
let turnFinished = false;
function connectionStatus(value: boolean) {
  connected = value;
  for (const client of clients) {
    (client as unknown as { setStatus(status: string): void }).setStatus(value ? "connected" : "disconnected");
  }
}
function emitPromptUpdate(update: Record<string, unknown>) {
  for (const client of clients) {
    (client as unknown as { handleIncoming(message: unknown): void }).handleIncoming({
      id: "fixture-update", source: "engine", timestamp: Date.now(),
      type: "AGENT_SESSION_UPDATE", agentId: "codex", chatId: chat.id, executionId: "execution-a",
      notification: { sessionId: "execution-a", executionId: "execution-a", update },
    });
  }
}
let releaseAccess: (() => void) | undefined;
const access = params.get("holdAccess")
  ? new Promise<void>((resolve) => {
      releaseAccess = resolve;
    })
  : Promise.resolve();
let releaseAdmission: (() => void) | undefined;
const admission = params.get("holdAdmission")
  ? new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    })
  : Promise.resolve();
Object.assign(window, {
  prActionsFixture: {
    requests,
    historyReads,
    promptTranscripts,
    prepareSession: () => sessionActions?.ensureSession(chat.id, "codex", { cwd: chat.folder }),
    holdHistory: (count: number) => { historyReadsToHold = count; },
    releaseHistory: (index: number) => historyReads[index]?.(),
    reconcileHistory: () => sessionActions?.hydrateChat(chat.id),
    queueFollowup: () => sessionActions?.sendPrompt(chat.id, "Queued follow-up"),
    releaseAccess: () => releaseAccess?.(),
    releaseAdmission: () => releaseAdmission?.(),
    disconnect: () => {
      connectionStatus(false);
      rejectPrompt?.(new Error("Request timeout: engine disconnected"));
    },
    reconnect: () => connectionStatus(true),
    stream: () => emitPromptUpdate({
      sessionUpdate: "agent_message_chunk", messageId: "reply-a",
      content: { type: "text", text: "Work started." },
    }),
    finishPrompt: () => {
      turnFinished = true;
      if (connected) emitPromptUpdate({
        sessionUpdate: "turn_state", turnId: runningPrompt?.userMessageId,
        state: "completed", stopReason: "end_turn", startedAt: 1,
      });
    },
    selectOtherChat: () =>
      useWorkspaceStore.setState({ activeChatId: otherChat.id }),
    archiveChat: () =>
      useWorkspaceStore.setState({
        chats: [{ ...chat, archived: true }, otherChat],
      }),
  },
});
window.__ZEROS_NATIVE__ = {
  invoke: async <T,>() => undefined as T,
  on: () => () => {},
};
registerAgentPreferencesFlush(async () => {});
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => (connected ? "connected" : "disconnected"),
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.send = () => {};
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as unknown as Request;
  clients.add(this);
  requests.push(request);
  let response: unknown;
  if (
    request.type === "AGENT_NEW_SESSION" ||
    request.type === "AGENT_LOAD_SESSION"
  ) {
    await admission;
    response = params.get("failAdmission")
      ? {
          type: "AGENT_ERROR",
          message: "Session startup failed",
          failure: {
            kind: "unknown",
            stage: "newSession",
            message: "Session startup failed",
          },
        }
      : request.type === "AGENT_LOAD_SESSION"
        ? {
            type: "AGENT_SESSION_LOADED",
            agentId: request.agentId,
            sessionId: "execution-a",
            executionId: "execution-a",
            ...(request.adoptOnly ? {
              promptActive: !turnFinished, promptId: runningPrompt?.promptId,
            } : {}),
            response: { sessionId: "execution-a" },
          }
        : {
            type: "AGENT_SESSION_CREATED",
            agentId: request.agentId,
            initialize: { protocolVersion: 1, agentCapabilities: {} },
            session: { sessionId: "execution-a" },
          };
  } else if (request.type === "AGENT_PROMPT") {
    promptTranscripts.push((useSessionsStore.getState().sessions[chat.id]?.messages ?? [])
      .flatMap((message) => message.kind === "text" ? [message.text] : []));
    if (params.has("holdPrompt")) {
      runningPrompt = request;
      return await new Promise<T>((_resolve, reject) => { rejectPrompt = reject; });
    }
    response = {
      type: "AGENT_PROMPT_COMPLETE",
      sessionId: request.sessionId,
      agentId: request.agentId,
      stopReason: "end_turn",
    };
  } else if (request.type === "AGENT_LIST_AGENTS") {
    response = {
      type: "AGENT_AGENTS_LIST",
      agents: [
        { id: "codex", name: "Codex", installed: true, authenticated: true },
      ],
    };
  } else if (request.type === "AGENT_INIT_AGENT") {
    response = {
      type: "AGENT_INITIALIZED",
      initialize: { protocolVersion: 1, agentCapabilities: {} },
    };
  } else {
    let result: unknown = null;
    switch (request.op) {
      case "gh.repoAccess":
        await access;
        result = { state: "ok" };
        break;
      case "git.status":
        result = {
          conflicted: [],
          conflictState: null,
          upstream: "origin/feature",
          ahead: 0,
          behind: 0,
        };
        break;
      case "git.changeCounts":
        result = { all: 1, uncommitted: 0, staged: 0, unstaged: 0 };
        break;
      case "gh.prGet":
        result = {
          number: 9,
          state: "open",
          mergeableState: "dirty",
          isMergeable: false,
          baseBranch: "main",
          headSha: "head",
        };
        break;
      case "gh.prChecks":
        result = { pending: 0, failed: 0, total: 0, checks: [] };
        break;
      case "git.repoBranchCatalog":
        result = {
          effectiveRemote: "origin",
          remotes: [
            {
              name: "origin",
              isGitHub: true,
              url: "https://github.com/example/fixture.git",
            },
          ],
        };
        break;
      case "workspace.list":
        result = { workspaces: [workspace] };
        break;
      case "messages.window":
        result = {
          messages: (turnFinished ? (useSessionsStore.getState().sessions[chat.id]?.messages ?? []).map(m =>
            m.kind === "text" && m.role === "agent" ? { ...m, text: "Work continued while disconnected." } : m,
          ) : history).filter((m) => !(m.kind === "text" && m.queued)).map((m) => ({
            msgId: m.id,
            kind: m.kind,
            payload: JSON.stringify(m),
            createdAt: m.createdAt,
          })),
        };
        // Capture before blocking so a ready-to-ready read really can return
        // an older transcript after an entire disconnected turn has finished.
        if (historyReadsToHold > 0) {
          historyReadsToHold--;
          await new Promise<void>((resolve) => historyReads.push(resolve));
        }
        break;
      case "turns.get":
        result = { turn: turnFinished ? {
          chatId: chat.id, turnId: runningPrompt?.userMessageId, agentId: "codex",
          status: "completed", stopReason: "end_turn",
        } : null };
        break;
      case "settings.read":
        result = { doc: {}, raw: "", exists: true };
        break;
    }
    response = { type: "WORKSPACE_RESPONSE", op: request.op, result };
  }
  return response as T;
};

function Harness() {
  const sessions = useAgentSessions();
  const slot = useSessionsStore((s) => s.sessions[chat.id]);
  useEffect(() => {
    sessionActions = sessions;
    sessions.setRetainedChatIds([chat.id]);
    return () => { if (sessionActions === sessions) sessionActions = null; };
  }, [sessions]);
  return (
    <div className="bg-bg1 text-fg1 min-h-screen p-4">
      {workspace.prNumber ? (
        <PrStatusIsland workspace={workspace} active localDesktop />
      ) : (
        <CreatePrButton
          workspace={workspace}
          originUrl="https://github.com/example/fixture.git"
        />
      )}
      <div data-transcript="" data-session-status={slot?.status} data-session-error={slot?.error ?? ""}>
        {slot?.messages.map((m) =>
          m.kind === "text" ? (
            <p key={m.id} data-auto-action={m.autoAction}>
              {m.text}
            </p>
          ) : null,
        )}
      </div>
      <Toaster />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <BridgeProvider>
      <AgentSessionsProvider>
        <Harness />
      </AgentSessionsProvider>
    </BridgeProvider>
  </TooltipProvider>,
);
