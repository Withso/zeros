// Synthetic identities exercise the production renderers/editor, with no
// provider run, filesystem write, or engine command behind the fixture.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentTextMessage,
  AgentToolMessage,
} from "@zeros/protocol/agent-messages";
import type { LocalLinkSnapshot } from "../platform/local-link-snapshot";
import { openLocalLink, onLocalNavigation } from "../platform/local-links";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { LocalLinksContext } from "../features/agent/local-links/context";
import {
  localLinkIndex,
  localLinkSourceEnabled,
} from "../features/agent/local-links/model";
import { LocalLinkPill } from "../features/agent/local-links/pill";
import { MessageView } from "../features/agent/renderers/message-view";
import type { RendererContext } from "../features/agent/renderers/types";
import { TurnPromptHeader } from "../features/agent/turn-container";
import {
  useComposerEditor,
  type ComposerEditorApi,
} from "../features/agent/composer-editor/use-composer-editor";
import { AttachmentPillView } from "../features/agent/composer-editor/pill-views";
import { useWorkspaceStore, type ChatThread } from "../state/store";

window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  invoke: async <T,>(command: string) =>
    (command === "app_info" ? { channel: "dev" } : null) as T,
};
const snapshot = {
  projects: [
    {
      id: "project",
      name: "Compiler",
      repoRoot: "/fixture",
      repoSlug: "compiler",
      originUrl: null,
      addedAt: 1,
    },
  ],
  workspaces: [
    {
      id: "ws_child",
      repoRoot: "/fixture",
      path: "/fixture-worktrees/child",
      repoSlug: "compiler",
      branch: "watchet",
      organizationId: null,
      placement: "local",
      archivedAt: null,
    },
  ],
  chats: ["claude", "codex", "cursor", "long"].map((id) => ({
    id,
    agentId: id === "long" ? "claude" : id,
    title: {
      claude: "Research",
      codex: "Implementation",
      cursor: "Verification",
      long: "Architecture and distribution audit with a very long chat title",
    }[id],
    folder: "/fixture",
    archived: false,
    kind: "chat",
  })),
} as LocalLinkSnapshot;
const pristine: ChatThread = {
  id: "pristine", title: "Untitled", agentId: "cursor", agentName: "Cursor",
  folder: "/fixture", model: null, effort: "high", permissionMode: "auto",
  createdAt: 1, updatedAt: 1,
};
const pristineMessage: AgentTextMessage = {
  id: "live-link", kind: "text", role: "user", createdAt: 1,
  text: 'Send "hi" to zeros-dev://chat/pristine',
};
const ref = {
  chatId: "codex",
  title: "Old title",
  agentId: "codex",
  link: "zeros-dev://chat/codex",
};
const user: AgentTextMessage = {
  id: "from",
  kind: "text",
  role: "user",
  createdAt: 1,
  localFrom: ref,
  text: "The implementation is ready. Review zeros-dev://workspace/ws_child when you have time.",
};
const steered: AgentTextMessage = {
  ...user,
  id: "steered",
  steeredTurnId: "human",
  localFrom: { ...ref, chatId: "long", link: "zeros-dev://chat/long" },
  text: "A peer update delivered during a running turn.",
};
const prose: AgentTextMessage = {
  id: "prose",
  kind: "text",
  role: "agent",
  createdAt: 2,
  text: "I compared [the research](zeros-dev://chat/claude) with zeros-dev://chat/cursor.\n\n```sh\nzeros-dev://chat/codex\n```\n\nForeign links stay plain: zeros-beta://chat/other.",
};
const notes: AgentTextMessage[] = [
  {
    ...user,
    id: "done",
    localFrom: undefined,
    localNote: { ...ref, event: "done", status: "cancelled" },
    text: "Chat finished",
  },
  {
    ...user,
    id: "permission",
    localFrom: undefined,
    localNote: { ...ref, event: "permission", cardTitle: "Run: pnpm test" },
    text: "Permission requested",
  },
  {
    ...user,
    id: "question",
    localFrom: undefined,
    localNote: { ...ref, event: "question", cardTitle: "Which target branch?" },
    text: "Question asked",
  },
];
const tool: AgentToolMessage = {
  kind: "tool",
  id: "create",
  toolCallId: "create",
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 2,
  updatedAt: 3,
  rawInput: {
    command:
      "zeros local chat create --agent claude --message 'Research the parser' --json",
  },
  rawOutput: {
    stdout: JSON.stringify({
      ok: true,
      protocol: 1,
      result: {
        chatId: "claude",
        link: "zeros-dev://chat/claude",
        title: "Research",
        agent: "claude",
      },
    }),
    exitCode: 0,
  },
};
const native: AgentToolMessage = {
  ...tool,
  id: "native",
  toolCallId: "native",
  title: "mcp__zeros_local__run",
  toolKind: "mcp",
  status: "in_progress",
  rawInput: { args: ["chat", "wait", "cursor", "--timeout", "8"] },
  rawOutput: undefined,
};
const child: AgentToolMessage = {
  ...tool,
  id: "subagent",
  toolCallId: "subagent",
  title: "Agent",
  toolKind: "subagent",
  rawInput: {
    description: "Check zeros-dev://chat/claude",
    prompt: "Review zeros-dev://workspace/ws_child",
  },
  rawOutput: { report: "See zeros-dev://chat/cursor" },
};
const tools: AgentToolMessage[] = [
  tool, native, child,
  {
    ...tool, id: "heredoc", toolCallId: "heredoc",
    rawInput: { command: "zeros local message send zeros-dev://chat/codex --request-id progress --message-file - <<'EOF'\nThe audit is ready.\nEOF" },
    rawOutput: { stdout: "Message delivered", exitCode: 0 },
  },
  {
    ...tool, id: "compound", toolCallId: "compound",
    rawInput: { command: "zeros local chat status zeros-dev://chat/codex && echo zeros-dev://workspace/ws_child" },
    rawOutput: { stdout: "Raw compound command", exitCode: 0 },
  },
  {
    ...tool, id: "generic-mcp", toolCallId: "generic-mcp", toolKind: "mcp",
    title: "Inspect zeros-dev://workspace/ws_child",
    rawInput: { server: "other", tool: "inspect" }, rawOutput: { text: "Report" },
  },
  {
    ...tool, id: "failed-local", toolCallId: "failed-local", status: "failed",
    rawInput: { command: "zeros local message send zeros-dev://chat/codex --message Update" },
    rawOutput: { stdout: "The chat has stopped", exitCode: 4 },
  },
  {
    ...tool, id: "failed-standard", toolCallId: "failed-standard", status: "failed",
    rawInput: { command: "pnpm test" }, rawOutput: { stdout: "Test failed", exitCode: 1 },
  },
  {
    ...child, id: "failed-agent", toolCallId: "failed-agent", status: "failed",
    rawInput: { description: "Failed review of zeros-dev://chat/cursor" },
    rawOutput: { report: "Ask zeros-dev://chat/claude for context." },
  },
];
const ctx: RendererContext = {
  isStreaming: false,
  lastMessageId: null,
  activeTurnStartedAt: 1,
  attachmentImagesActive: true,
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  editBaselines: new Map(),
  subagentChildren: new Map(),
  respondToPermission: () => {},
  respondToQuestion: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  editAndResubmit: () => {},
  setMode: null,
  chatId: "fixture",
};

declare global {
  interface Window {
    __localLinksComposer?: ComposerEditorApi;
  }
}

function Composer() {
  const editor = useComposerEditor({
    agentId: "codex",
    agentName: "Codex",
    agentSupportsImage: true,
    modelId: null,
    cwd: null,
    originUrl: null,
    availableCommands: [],
    placeholder: "Paste a Local link",
    onSubmit: () => {},
  });
  useLayoutEffect(() => {
    window.__localLinksComposer = editor;
    return () => {
      delete window.__localLinksComposer;
    };
  }, [editor]);
  return (
    <div
      data-testid="local-link-composer"
      className="border-border2 bg-bg2 rounded-lg border p-3"
    >
      {editor.editorContent}
      {editor.suggestionPopup}
    </div>
  );
}

function Harness() {
  const [source, setSource] = useState("local");
  const [clicked, setClicked] = useState("");
  const [light, setLight] = useState(false);
  const chats = useWorkspaceStore((state) => state.chats);
  const dispatch = useWorkspaceStore((state) => state.dispatch);
  const index = useMemo(() => localLinkIndex(snapshot, chats), [chats]);
  useEffect(() => {
    let current = true;
    let stop: (() => void) | undefined;
    void onLocalNavigation((link) =>
      setClicked(`${link.kind}:${link.id}`),
    ).then((off) => {
      if (current) stop = off;
      else off();
    });
    return () => {
      current = false;
      stop?.();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }, [light]);
  const value = useMemo(
    () => ({
      enabled: localLinkSourceEnabled({
        rollout: source !== "closed",
        organizationId: source === "organization" ? "org" : null,
        runtimeKind: source === "cloud" ? "cloud" : "local",
        cwd: "/fixture",
        index,
      }),
      scheme: "zeros-dev" as const,
      index,
      navigate: openLocalLink,
    }),
    [source, index],
  );
  return (
    <TooltipProvider>
      <LocalLinksContext.Provider value={value}>
        <main
          data-zeros-root=""
          className="bg-bg1 text-fg1 min-h-screen p-6 text-sm"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setLight((current) => !current)}>
                Toggle theme
              </Button>
              {["local", "organization", "cloud", "closed"].map((kind) => (
                <Button key={kind} onClick={() => setSource(kind)}>
                  {kind}
                </Button>
              ))}
              <span data-testid="navigation" className="text-fg3">
                {clicked}
              </span>
            </div>
            <div
              data-testid="pill-specimens"
              className="flex flex-wrap items-center gap-2"
            >
              {["claude", "codex", "cursor", "missing"].map((id) => (
                <LocalLinkPill key={id} href={`zeros-dev://chat/${id}`} />
              ))}
              <LocalLinkPill href="zeros-dev://workspace/ws_child" />
              <LocalLinkPill href="zeros-dev://workspace/folder%3Aproject" />
              <AttachmentPillView name="Screenshot.png" kind="file" />
            </div>
            <div data-testid="live-chat" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => dispatch({ type: "ADD_CHAT", chat: pristine })}>
                  Add pristine chat
                </Button>
                <Button onClick={() => dispatch({ type: "UPDATE_CHAT_TITLE", id: pristine.id, title: "Live review" })}>
                  Rename pristine chat
                </Button>
                <Button onClick={() => dispatch({ type: "ARCHIVE_CHAT", id: pristine.id })}>
                  Archive pristine chat
                </Button>
              </div>
              <TurnPromptHeader originalText={pristineMessage.text}>
                <MessageView message={pristineMessage} ctx={ctx} />
              </TurnPromptHeader>
            </div>
            <div data-testid="sent-from">
              <TurnPromptHeader originalText={user.text} localFrom={user.localFrom}>
                <MessageView message={user} ctx={ctx} />
              </TurnPromptHeader>
            </div>
            <div data-testid="steered-from">
              <TurnPromptHeader originalText={steered.text} localFrom={steered.localFrom}>
                <MessageView message={steered} ctx={{ ...ctx, isStreaming: true }} />
              </TurnPromptHeader>
            </div>
            <div data-testid="saved-from">
              <TurnPromptHeader originalText="Saved transcript message" localFrom={ref} surfaceActive={false}>
                <MessageView message={{ ...user, text: "Saved transcript message" }} ctx={{ ...ctx, attachmentImagesActive: false }} />
              </TurnPromptHeader>
            </div>
            <div data-testid="short-from">
              <TurnPromptHeader originalText="hi" localFrom={ref}>
                <MessageView message={{ ...user, text: "hi" }} ctx={ctx} />
              </TurnPromptHeader>
            </div>
            <div data-testid="agent-prose">
              <MessageView message={prose} ctx={ctx} />
            </div>
            <div data-testid="local-notes">
              {notes.map((message) => (
                <MessageView key={message.id} message={message} ctx={ctx} />
              ))}
            </div>
            <div data-testid="local-tools" className="flex flex-col gap-2">
              {tools.map((message) => <div key={message.id} data-testid={`tool-${message.id}`}><MessageView message={message} ctx={ctx} /></div>)}
            </div>
            <Composer />
          </div>
        </main>
      </LocalLinksContext.Provider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
