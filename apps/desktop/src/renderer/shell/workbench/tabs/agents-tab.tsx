// The Agents tab: the workspace's parent sessions along the top, and the
// selected parent's child sessions below, grouped by what they are doing.

import { useMemo, useState } from "react";
import { AgentAwaitingIcon } from "../../../features/agent/agent-awaiting-indicator";
import { chatAgentActivity } from "../../../features/agent/agent-activity";
import { AgentIcon } from "../../../features/agent/agent-icon";
import { awaitingKindOfSlot, useSessionsStore } from "../../../features/agent/sessions-store";
import { RunStream } from "../../../shared/ui/loading";
import { ListRow, Tabs, TabsList, TabsTrigger } from "../../../shared/ui/primitives";
import { buildSessionTree, sessionRootId, type SessionNode } from "../../../state/session-tree";
import { selectActiveFolder, useWorkspaceDispatch, useWorkspaceStore, type ChatThread } from "../../../state/store";
import { useActiveChatId, useChats } from "../../../state/workspace-store";
import { sessionName } from "../../conversation/session-switcher";
import type { WorkbenchTab } from "../tab-model";

type SessionStatus = "input" | "plan" | "running" | "idle";

const GROUPS: ReadonlyArray<{ id: string; label: string; has: (status: SessionStatus) => boolean }> = [
  { id: "needs-input", label: "Needs input", has: (status) => status === "input" || status === "plan" },
  { id: "working", label: "Working", has: (status) => status === "running" },
  { id: "idle", label: "Idle", has: (status) => status === "idle" },
];

/** One status per id, behind a primitive selector so unrelated session
 *  updates do not re-render the tab. */
export function useSessionStatuses(ids: readonly string[]): readonly SessionStatus[] {
  const key = useSessionsStore((state) => ids.map((id) => {
    const slot = state.sessions[id];
    const awaiting = slot ? awaitingKindOfSlot(slot) : null;
    if (awaiting) return awaiting;
    return chatAgentActivity(slot, state.pendingLocalTurns[id]) === "running" ? "running" : "idle";
  }).join(","));
  return useMemo(() => (key ? (key.split(",") as SessionStatus[]) : []), [key]);
}

function descendants(node: SessionNode): ChatThread[] {
  return node.children.flatMap((child) => [child.chat, ...descendants(child)]);
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

function StatusMark({ status }: { status: SessionStatus }) {
  if (status === "input" || status === "plan") {
    return <AgentAwaitingIcon kind={status} className="size-3.5 shrink-0" strokeWidth={1.25} />;
  }
  if (status === "running") return <RunStream size={12} className="text-blue-primary shrink-0" />;
  return null;
}

function SessionListRow({ chat, folder, status, active, onSelect }: {
  chat: ChatThread;
  folder: string;
  status: SessionStatus;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <ListRow
      variant="panel"
      aria-pressed={active}
      onClick={() => onSelect(chat.id)}
      data-agents-row={chat.id}
    >
      <AgentIcon agentId={chat.agentId ?? ""} iconUrl={null} size={14} />
      <span className="text-fg1 min-w-0 flex-1 truncate text-xs">{sessionName(chat)}</span>
      {chat.folder !== folder && (
        <span className="text-fg3 border-border1 shrink-0 rounded-sm border px-1 text-xxs leading-4" data-session-workspace="">
          {folderName(chat.folder)}
        </span>
      )}
      <StatusMark status={status} />
    </ListRow>
  );
}

export function AgentsTab({ scope }: { tab: WorkbenchTab; active: boolean; scope?: string }) {
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const folder = scope ?? activeFolder ?? "";
  const chats = useChats();
  const activeId = useActiveChatId();
  const dispatch = useWorkspaceDispatch();
  const tree = useMemo(() => buildSessionTree(chats, folder), [chats, folder]);
  const [picked, setPicked] = useState<string | null>(null);
  const activeRoot = activeId ? sessionRootId(tree, activeId) : null;
  const parentId = (picked && tree.byId.has(picked) ? picked : null)
    ?? (activeRoot && tree.roots.some((root) => root.chat.id === activeRoot) ? activeRoot : null)
    ?? tree.roots[0]?.chat.id
    ?? null;
  const parent = parentId ? tree.byId.get(parentId) : undefined;
  const children = useMemo(() => (parent ? descendants(parent) : []), [parent]);
  const terminals = useMemo(
    () => chats.filter((chat) => chat.kind === "terminal" && !chat.archived && chat.folder === folder),
    [chats, folder],
  );
  const childIds = useMemo(() => children.map((chat) => chat.id), [children]);
  const statuses = useSessionStatuses(childIds);
  const select = (id: string) => dispatch({ type: "SET_ACTIVE_CHAT", id });

  if (tree.roots.length === 0 && terminals.length === 0) {
    return <div className="text-fg3 flex h-full items-center justify-center text-xs" data-agents-empty="">No sessions yet</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-agents-tab="">
      {tree.roots.length > 0 && (
        <Tabs value={parentId ?? undefined} onValueChange={setPicked}>
          <TabsList variant="chrome" aria-label="Parent sessions" className="border-border1 w-full overflow-x-auto border-b">
            {tree.roots.map((root) => (
              <TabsTrigger key={root.chat.id} variant="chrome" value={root.chat.id} className="max-w-48" data-agents-parent={root.chat.id}>
                <span className="min-w-0 truncate">{sessionName(root.chat)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {parent && children.length === 0 && (
          <p className="text-fg3 px-3 py-2 text-xs">No child sessions</p>
        )}
        {GROUPS.map((group) => {
          const rows = children.filter((_, index) => group.has(statuses[index] ?? "idle"));
          if (rows.length === 0) return null;
          return (
            <section key={group.id} aria-label={group.label} className="pb-2" data-agents-group={group.id}>
              <h3 className="text-fg3 px-3 pb-1 text-xxs font-medium">{group.label} · {rows.length}</h3>
              {rows.map((chat) => (
                <SessionListRow
                  key={chat.id}
                  chat={chat}
                  folder={folder}
                  status={statuses[childIds.indexOf(chat.id)] ?? "idle"}
                  active={chat.id === activeId}
                  onSelect={select}
                />
              ))}
            </section>
          );
        })}
        {terminals.length > 0 && (
          <section aria-label="Terminal agents" className="pb-2" data-agents-group="terminals">
            <h3 className="text-fg3 px-3 pb-1 text-xxs font-medium">Terminal agents · {terminals.length}</h3>
            {terminals.map((chat) => (
              <SessionListRow key={chat.id} chat={chat} folder={folder} status="idle" active={chat.id === activeId} onSelect={select} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
