// Real tab rows, composer, draft store and persistence; synthetic workspace I/O.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { Profiler, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTabs } from "../shell/conversation/chat-tabs";
import { WorkspaceTab } from "../shell/top-bar";
import { rememberChangeLines } from "../shell/use-workspace-change-lines";
import { useWorkspaceStore } from "../state/workspace-store";
import { useChatPanesStore, usePaneLayout } from "../state/chat-panes-store";
import {
  MAIN_PANE_ID,
  leafIds,
  paneForChat,
  resolvePaneActiveChatId,
  type SplitDirection,
} from "../state/chat-panes";
import { draftChatIdsByWorkspace } from "../state/composer-draft-presence";
import { persistDraftsNow } from "../state/persist-composer-drafts";
import type { ChatThread, ComposerDraft } from "../state/store";
import type { Workspace } from "../platform/git";
import { useComposerEditor } from "../features/agent/composer-editor/use-composer-editor";
import { setLiveChatDraft } from "../features/agent/composer-live-drafts";
import { useSessionsStore } from "../features/agent/sessions-store";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";

const workspaces: Workspace[] = ["a", "b"].map((id) => ({
  id,
  path: `/draft-indicators/${id}`,
  branch:
    id === "a"
      ? "example/A-workspace-name-that-exceeds-the-maximum-tab-width"
      : "example/Other",
  repoRoot: "/draft-indicators",
  repoSlug: "draft-indicators",
  baseBranch: "main",
  status: "in-progress",
  createdAt: 1,
  archivedAt: null,
  stashRef: null,
  prNumber: null,
  prState: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: null,
}));
const chats: ChatThread[] = ["a", "a-other", "a-background", "b"].map((id) => ({
  id: `draft-${id}`,
  folder: workspaces[id === "b" ? 1 : 0].path,
  agentId: "claude",
  agentName: "Claude",
  model: null,
  effort: "high",
  permissionMode: "auto",
  title:
    id === "a"
      ? "A chat name that exceeds the maximum tab width"
      : "Other chat",
  createdAt: 1,
  updatedAt: 1,
}));
useWorkspaceStore.setState({
  chats,
  activeChatId: "draft-a",
  ...(new URLSearchParams(location.search).has("fresh")
    ? { chatComposerDrafts: {}, editComposerDrafts: {} }
    : {}),
});
useChatPanesStore.setState({ byFolder: {}, pendingAssigns: [] });
for (const workspace of workspaces)
  rememberChangeLines(workspace.id, {
    additions: workspace.id === "a" ? 5800 : 0,
    deletions: 0,
  });
setActiveBridge({
  status: "connected",
  onStatusChange: () => () => {},
  onMessage: () => () => {},
  request: async (message: {
    op: string;
    params?: Record<string, unknown>;
  }) => {
    const p = message.params ?? {};
    let result: unknown = {};
    if (message.op === "workspace.list") result = { workspaces };
    if (message.op === "attachment.write")
      result = {
        bytes: p.totalBytes,
        pending: p.base64 === "",
        mimeType: p.mimeType,
        relativePath: `.context/local/attachments/${p.attachmentId}/${p.filename}`,
        absolutePath: `${p.cwd}/.context/local/attachments/${p.attachmentId}/${p.filename}`,
      };
    if (message.op === "git.changeLineCounts")
      result = {
        additions: p.workspaceId === "a" ? 5800 : 0,
        deletions: 0,
      };
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as unknown as RuntimeClient);

const emptyDraft = (): ComposerDraft => ({
  text: "",
  attachments: [],
  json: null,
});
const commits: Record<string, number> = {};
const countCommit = (id: string) => {
  commits[id] = (commits[id] ?? 0) + 1;
};
const composers = new Map<
  string,
  { clear: () => void; attach: () => Promise<void> }
>();
const archiveRequests: string[] = [];
const project = {
  id: "draft-indicators",
  name: "Draft indicators",
  repoRoot: "/draft-indicators",
  repoSlug: "draft-indicators",
  originUrl: null,
  addedAt: 1,
};
const mixedWorkspace = {
  ...workspaces[1],
  branch: "example/Other-workspace-name-that-exceeds-the-maximum-tab-width",
};
Object.assign(window, {
  draftIndicatorsHarness: {
    commits: () => ({ ...commits }),
    clear: () =>
      composers.get(useWorkspaceStore.getState().activeChatId!)?.clear(),
    attach: () =>
      composers.get(useWorkspaceStore.getState().activeChatId!)?.attach(),
    flush: () => persistDraftsNow(useWorkspaceStore.getState()),
    archives: () => [...archiveRequests],
    mixedBusy: (enabled: boolean) =>
      useSessionsStore.setState({
        pendingLocalTurns: enabled ? { "draft-b": "fixture-turn" } : {},
      }),
    split: (direction: SplitDirection | null) => {
      const store = useChatPanesStore.getState();
      useChatPanesStore.setState({ byFolder: {} });
      if (direction) {
        store.splitPane(
          workspaces[0].path,
          MAIN_PANE_ID,
          direction,
          "draft-a-other",
        );
        store.setPaneActiveChat(workspaces[0].path, MAIN_PANE_ID, "draft-a");
      }
    },
  },
});

function Composer({ chat }: { chat: ChatThread }) {
  const initial = useRef(
    useWorkspaceStore.getState().chatComposerDrafts[chat.id] ?? emptyDraft(),
  );
  const live = useRef(initial.current);
  const synchronize = useRef(() => {});
  const composer = useComposerEditor({
    agentId: null,
    agentName: null,
    agentSupportsImage: true,
    modelId: null,
    cwd: chat.folder,
    originUrl: null,
    availableCommands: [],
    placeholder: "Message",
    initialContent: {
      json: initial.current.json ?? null,
      attachments: initial.current.attachments,
    },
    onSubmit: () => composers.get(chat.id)?.clear(),
    onChange: () => synchronize.current(),
  });
  synchronize.current = () => {
    const snapshot = composer.serialize();
    if (!snapshot) return;
    live.current = {
      text: snapshot.displayText,
      attachments: snapshot.attachments,
      json: snapshot.json,
    };
    setLiveChatDraft(chat.id, live.current);
  };
  const clear = () => {
    composer.setContent({
      json: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [],
    });
    synchronize.current();
    useWorkspaceStore
      .getState()
      .dispatch({ type: "CLEAR_CHAT_DRAFT", chatId: chat.id });
  };
  const attach = () =>
    composer.insertFiles([
      new File(["Unsent file"], "notes.txt", { type: "text/plain" }),
    ]);
  composers.set(chat.id, { clear, attach });
  useEffect(
    () => () => {
      const draft = live.current;
      useWorkspaceStore
        .getState()
        .dispatch(
          draft.text.trim() || draft.attachments.length
            ? { type: "SET_CHAT_DRAFT", chatId: chat.id, draft }
            : { type: "CLEAR_CHAT_DRAFT", chatId: chat.id },
        );
      setLiveChatDraft(chat.id, null);
      composers.delete(chat.id);
    },
    [chat.id],
  );
  return (
    <section
      data-composer-chat={chat.id}
      className="border-border1 bg-bg2 mt-4 rounded-lg border p-4"
    >
      {composer.editorContent}
    </section>
  );
}

function Harness() {
  const allChats = useWorkspaceStore((state) => state.chats);
  const mixed = useSessionsStore((state) =>
    Boolean(state.pendingLocalTurns["draft-b"]),
  );
  const [workspaceId, setWorkspaceId] = useState("a");
  const chatId = useWorkspaceStore((state) => state.activeChatId);
  const workspace = workspaces.find((owner) => owner.id === workspaceId)!;
  const layout = usePaneLayout(workspace.path);
  const draftIds = draftChatIdsByWorkspace(allChats, workspaces);
  const selectChat = (id: string) => {
    useChatPanesStore
      .getState()
      .setPaneActiveChat(workspace.path, paneForChat(layout, id), id);
    useWorkspaceStore.setState({ activeChatId: id });
  };
  const selectWorkspace = (owner: Workspace) => {
    setWorkspaceId(owner.id);
    useWorkspaceStore.setState({
      activeChatId: allChats.find(
        (chat) => chat.folder === owner.path && !chat.archived,
      )!.id,
    });
  };
  return (
    <main className="bg-bg1 text-fg1 min-h-screen p-4">
      <div
        className="flex gap-1"
        data-testid="workspace-tabs"
        onPointerMove={(event) => {
          const hovered = (event.target as Element).closest<HTMLElement>(
            "[data-workspace-tab]",
          );
          for (const tab of event.currentTarget.querySelectorAll<HTMLElement>(
            "[data-workspace-tab]",
          )) {
            if (tab === hovered) tab.dataset.hovered = "true";
            else delete tab.dataset.hovered;
          }
        }}
        onPointerLeave={(event) => {
          for (const tab of event.currentTarget.querySelectorAll<HTMLElement>(
            "[data-workspace-tab]",
          ))
            delete tab.dataset.hovered;
        }}
      >
        {workspaces.map((owner) => (
          <Profiler
            key={owner.id}
            id={`workspace-${owner.id}`}
            onRender={countCommit}
          >
            <WorkspaceTab
              workspace={mixed && owner.id === "b" ? mixedWorkspace : owner}
              active={owner.id === workspaceId}
              chatIds={draftIds.get(owner.id)!}
              draftChatIds={draftIds.get(owner.id)!}
              project={mixed ? project : null}
              mixedRepositories={mixed}
              groupedRepository={false}
              groupEnd={false}
              onSelect={selectWorkspace}
              onPrefetch={() => {}}
              onArchive={(owner) => archiveRequests.push(owner.id)}
            />
          </Profiler>
        ))}
      </div>
      <div
        className={
          layout.root.type === "split" && layout.root.direction === "row"
            ? "flex gap-2"
            : "flex flex-col gap-2"
        }
      >
        {leafIds(layout.root).map((paneId) => {
          const paneChats = allChats.filter(
            (chat) =>
              chat.folder === workspace.path &&
              !chat.archived &&
              paneForChat(layout, chat.id) === paneId,
          );
          const selectedId = resolvePaneActiveChatId(
            layout,
            paneId,
            chatId,
            paneChats,
          );
          const selected = paneChats.find((chat) => chat.id === selectedId);
          return (
            <section
              key={paneId}
              className="min-w-0 flex-1"
              data-pane-root=""
              data-pane-focused={paneForChat(layout, chatId!) === paneId}
              onFocusCapture={() => {
                if (selectedId && selectedId !== chatId) selectChat(selectedId);
              }}
            >
              <Profiler id="chat-tabs" onRender={countCommit}>
                <ChatTabs
                  workspaceFolder={workspace.path}
                  paneId={paneId}
                  chats={paneChats}
                  historyChats={allChats.filter(
                    (chat) => chat.folder === workspace.path && chat.archived,
                  )}
                  activeChatId={selectedId}
                  showSyntheticUntitled={false}
                  onSelectUntitled={() => {}}
                  onSelectChat={selectChat}
                  onPrefetchChat={() => {}}
                  onCloseTab={(chat, event) => {
                    event?.stopPropagation();
                    useWorkspaceStore.setState({
                      chats: allChats.map((value) =>
                        value.id === chat.id
                          ? { ...value, archived: true }
                          : value,
                      ),
                    });
                  }}
                  onRestoreChat={() => {}}
                  onSplit={() => {}}
                  canSplitDown={false}
                  canSplitRight={false}
                />
              </Profiler>
              {selected && <Composer key={selected.id} chat={selected} />}
            </section>
          );
        })}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ActionsCtx.Provider value={{} as SessionsActions}>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </ActionsCtx.Provider>,
);
