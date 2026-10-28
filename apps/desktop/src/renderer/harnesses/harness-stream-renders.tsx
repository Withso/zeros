// Real stores, chat/composer, tab strip and workbench; only native I/O is fake.
import "./stream-render-observer";
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AgentChat } from "../features/agent/agent-chat";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { useChatSession } from "../features/agent/sessions-hooks";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import { loadAgents } from "../features/agent/agents-cache";
import { ChatTabs } from "../shell/conversation/chat-tabs";
import { WorkspaceHeader } from "../shell/conversation/workspace-header";
import { WorkbenchPane } from "../shell/workbench/workbench-pane";
import { AppSidebar } from "../shell/app-sidebar";
import { AddProjectProvider } from "../shell/add-project-provider";
import { TooltipProvider } from "../shared/ui/primitives";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { SessionNotification } from "../platform/bridge/agent-events";
import { useWorkspaceStore } from "../state/workspace-store";
import { createStreamingMarkdownRenderer, renderMarkdownSegments } from "../features/agent/markdown";
import {
  AuthContext,
  type AuthContextValue,
} from "../features/auth/auth-context";

const noop = () => {};
const optimized = new URLSearchParams(location.search).get("baseline") !== "1";
const streamKind = new URLSearchParams(location.search).get("kind") ?? "prose";
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
const folder = "/fixture/stream/local";
const chats = ["A", "B"].map((name) => ({
  id: `stream-${name}`,
  folder,
  agentId: "codex",
  agentName: "Codex",
  title: `Chat ${name}`,
  model: "gpt-6-astra",
  effort: "high" as const,
  permissionMode: "auto" as const,
  createdAt: 1,
  updatedAt: 1,
}));
window.__ZEROS_NATIVE__ = { on: () => noop, invoke: async <T,>() => null as T };
setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  status: "connected",
  on: () => noop,
  onStatusChange: () => noop,
  send: noop,
  request: async (request: { type: string; op: string }) =>
    request.type === "AGENT_LIST_AGENTS"
      ? { type: "AGENT_AGENTS_LIST", agents }
      : { type: "WORKSPACE_RESPONSE", op: request.op, result: {} },
} as unknown as RuntimeClient);
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
    status: chat.id === chats[0].id ? "streaming" : "ready",
    sessionId: chat.id,
    executionId: chat.id,
    transcriptState: "resident",
    hasTranscript: true,
    messages: [
      {
        id: `${chat.id}-prompt`,
        kind: "text",
        role: "user",
        text: "Explain the change.",
        createdAt: 1,
      },
      ...(chat.id === "stream-A" && streamKind === "tool" ? [{
        id: `${chat.id}-answer`, kind: "tool" as const, toolCallId: "command", title: "Run checks",
        toolKind: "execute" as const, status: "in_progress" as const, rawInput: { command: "pnpm test" },
        rawOutput: "The output starts here.", createdAt: 2, updatedAt: 2,
      }] : [{
        id: `${chat.id}-answer`,
        messageId: `${chat.id}-answer`,
        kind: "text" as const,
        role: chat.id === "stream-A" && streamKind === "thought" ? "thought" as const : "agent" as const,
        text: "The answer starts here.",
        createdAt: 2,
      }]),
    ],
  });
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
} as unknown as SessionsActions;
await loadAgents(actions.listAgents);
const auth = {
  status: "unauthenticated",
  session: null,
  userId: null,
  email: null,
  startBrowserSignIn: async () => ({ ok: false }),
  oauthError: null,
  clearOAuthError: noop,
  cancelPendingOAuth: noop,
  signOut: async () => {},
  signOutEverywhere: async () => {},
} as AuthContextValue;

const commits: Record<string, number> = {};
let publications = 0;
useSessionsStore.subscribe(() => {
  publications++;
});
let select: (id: string) => void = noop;
const countCommit = (id: string) => {
  commits[id] = (commits[id] ?? 0) + 1;
};
function Chat({ id, active }: { id: string; active: boolean }) {
  const session = useChatSession(id, active, optimized);
  return (
    <AgentChat
      liveTextUpdates={optimized}
      chatId={id}
      session={session}
      surfaceActive={active}
      onBack={noop}
      headerActions={<></>}
    />
  );
}
function Harness() {
  const [selected, setSelected] = useState(chats[0].id);
  select = setSelected;
  return (
    <AuthContext.Provider value={auth}>
      <ActionsCtx.Provider value={actions}>
        <TooltipProvider>
          <AddProjectProvider>
            <main className="bg-bg1 text-fg1 flex h-screen">
              <Profiler id="sidebar" onRender={countCommit}>
                <AppSidebar />
              </Profiler>
              <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Profiler id="header" onRender={countCommit}>
                  <WorkspaceHeader folder={folder} name="Stream fixture" />
                </Profiler>
                <Profiler id="tabs" onRender={countCommit}>
                  <ChatTabs
                    workspaceFolder={folder}
                    paneId="fixture"
                    chats={chats}
                    activeChatId={selected}
                    historyChats={[]}
                    showSyntheticUntitled={false}
                    onSelectUntitled={noop}
                    onSelectChat={setSelected}
                    onPrefetchChat={noop}
                    onCloseTab={noop}
                    onRestoreChat={noop}
                    onSplit={noop}
                    canSplitRight={false}
                    canSplitDown={false}
                  />
                </Profiler>
                {chats.map((chat) => (
                  <div
                    key={chat.id}
                    data-chat={chat.id}
                    className={
                      selected === chat.id
                        ? "flex min-h-0 flex-1 flex-col"
                        : "hidden"
                    }
                    {...(selected === chat.id ? {} : { inert: "" })}
                  >
                    <Profiler id={chat.id} onRender={countCommit}>
                      <Chat id={chat.id} active={selected === chat.id} />
                    </Profiler>
                  </div>
                ))}
              </section>
              <Profiler id="workbench" onRender={countCommit}>
                <WorkbenchPane onToggleWorkbench={noop} />
              </Profiler>
            </main>
          </AddProjectProvider>
        </TooltipProvider>
      </ActionsCtx.Provider>
    </AuthContext.Provider>
  );
}
const fixture = {
  appendText(text: string) {
    flushSync(() => useSessionsStore.getState().applyBridgeTranscriptUpdates([{
      sessionId: chats[0].id,
      update: { sessionUpdate: "agent_message_chunk", messageId: `${chats[0].id}-answer`, content: { type: "text", text } },
    }]));
  },
  verifyMarkdown() {
    const render = createStreamingMarkdownRenderer();
    const input = "Example:\n\n```ts\nconst value = 1;\n```\n\nTail <img src=x onerror=alert(1)> [link](javascript:alert(1))";
    for (let end = 0; end <= input.length; end++) {
      const text = input.slice(0, end);
      if (JSON.stringify(render(text)) !== JSON.stringify(renderMarkdownSegments(text)))
        throw new Error(`Markdown parity failed at ${end}`);
    }
    return input.length + 1;
  },
  select(id: string) {
    flushSync(() => {
      select(id);
      useWorkspaceStore.setState({ activeChatId: id });
    });
  },
  measure(frames = 10, deltas = 30) {
    const counters = window as unknown as {
      streamRenderCounts: Record<string, number>;
      streamRenderCauses: Record<string, Record<string, number>>;
    };
    counters.streamRenderCounts = {};
    counters.streamRenderCauses = {};
    for (const key of Object.keys(commits)) delete commits[key];
    publications = 0;
    for (let frame = 0; frame < frames; frame++) {
      flushSync(() => {
        const updates: SessionNotification[] = [];
        const previous = useSessionsStore.getState().sessions[chats[0].id].messages.at(-1);
        const output = previous?.kind === "tool" ? String(previous.rawOutput) : "";
        for (let index = 0; index < deltas; index++)
          updates.push({
            sessionId: chats[0].id,
            update: streamKind === "tool" ? {
              sessionUpdate: "tool_call_update", toolCallId: "command", status: "in_progress",
              rawOutput: `${output}${" x".repeat(index + 1)}`,
            } : {
              sessionUpdate: streamKind === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
              messageId: `${chats[0].id}-answer`,
              content: { type: "text", text: " x" },
            },
          } as SessionNotification);
        if (optimized)
          useSessionsStore.getState().applyBridgeTranscriptUpdates(updates);
        else
          for (const update of updates)
            useSessionsStore.getState().applyBridgeUpdate(update);
      });
    }
    const message = useSessionsStore
      .getState()
      .sessions[chats[0].id].messages.at(-1);
    const text = message?.kind === "text" ? message.text : message?.kind === "tool" ? String(message.rawOutput) : "";
    const painted =
      document
        .querySelector("[data-chat='stream-A'] .zeros-agent-messages")
        ?.textContent?.trimEnd() ?? "";
    return {
      frames,
      deltas,
      publications,
      commits: { ...commits },
      renders: { ...counters.streamRenderCounts },
      causes: counters.streamRenderCauses,
      textLength: text.length,
      paintedTextLength: painted.length,
      paintedLatest: painted.includes(text),
    };
  },
};
Object.assign(window, { streamRenderFixture: fixture });
createRoot(document.getElementById("root")!).render(<Harness />);
