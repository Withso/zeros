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
  prompt?: { type: string; text?: string }[];
  bubble?: { displayText?: string; autoAction?: string };
};
const requests: Request[] = [];
let connected = true;
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
    releaseAccess: () => releaseAccess?.(),
    releaseAdmission: () => releaseAdmission?.(),
    disconnect: () => {
      connected = false;
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
            response: { sessionId: "execution-a" },
          }
        : {
            type: "AGENT_SESSION_CREATED",
            agentId: request.agentId,
            initialize: { protocolVersion: 1, agentCapabilities: {} },
            session: { sessionId: "execution-a" },
          };
  } else if (request.type === "AGENT_PROMPT") {
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
          messages: history.map((m) => ({
            msgId: m.id,
            kind: m.kind,
            payload: JSON.stringify(m),
            createdAt: m.createdAt,
          })),
        };
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
  useEffect(() => sessions.setRetainedChatIds([chat.id]), [sessions]);
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
      <div data-transcript="">
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
