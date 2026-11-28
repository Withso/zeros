// The Workbench Agents tab: the open workspace's parent sessions as tabs that
// float above their children, grouped like the sidebar's Group › Status into
// cards (Needs you, Working, Idle, Archived). Each child is a two-line row:
// its status dot or loader in the agent icon's place, then line 2 with the
// status word or time, PR marks and, for a child elsewhere, where it runs.
// Side chats are Workbench tabs of their own and never appear here.

import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Bot, Terminal } from "lucide-react";
import { AgentActivityIndicator } from "../../../features/agent/agent-activity-indicator";
import { chatAgentActivity } from "../../../features/agent/agent-activity";
import { AgentIcon } from "../../../features/agent/agent-icon";
import { chatUnread, subscribeChatUnread } from "../../../features/agent/chat-unread";
import { formatCompactAge } from "../../../features/agent/format-age";
import { useNativeSubagents, type NativeSubagent } from "../../../features/agent/native-subagents";
import { awaitingKindOfSlot, useSessionsStore } from "../../../features/agent/sessions-store";
import { sessionViewChatId } from "../../../features/agent/side-chat";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import type { Workspace } from "../../../platform/git";
import { cn } from "../../../shared/ui/cn";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "../../../shared/ui/primitives";
import { openSession } from "../../../state/open-session";
import { buildSessionTree, sessionDescendantIds, sessionRootId, type SessionNode } from "../../../state/session-tree";
import { setupFailureShown, useSetupFailureAcknowledgements } from "../../../state/setup-failure-acknowledgements";
import { selectActiveFolder, useWorkspaceDispatch, useWorkspaceStore, type ChatThread } from "../../../state/store";
import { useActiveWorkspace } from "../../../state/use-active-workspace";
import { useLiveWorkspaces } from "../../../state/use-projects";
import { findWorkspaceForFolder } from "../../../state/workspace-resolution";
import { useActiveChatId, useChats } from "../../../state/workspace-store";
import { sessionName } from "../../conversation/session-switcher";
import { SidebarGroupHeader } from "../../sidebar-group-header";
import { useCloudErrorWorkspaceIds, useCloudWorkspaceStatus } from "../../sidebar-cloud-mark";
import { prMarkGroups, workspacePullRequests, type SidebarPullRequest } from "../../sidebar-view-model";
import { SidebarPlacementIcon, SidebarPrMarks, STATUS_TONE_CLS, sidebarStatusDot } from "../../sidebar-workspace-row-meta";
import type { WorkbenchTab } from "../tab-model";
import { useWorkbenchStatusSource } from "../tab-status";
import {
  agentsChildCloudError,
  agentsGroupOf,
  agentsRowPlace,
  agentsRowStatus,
  groupAgentsRows,
  type AgentsGroupId,
  type AgentsRowPlace,
  type AgentsRowSignal,
  type AgentsSessionStatus,
} from "./agents-tab-model";

/** One status per id, behind a primitive selector so unrelated session
 *  updates do not re-render the tab. */
export function useSessionStatuses(ids: readonly string[]): readonly AgentsSessionStatus[] {
  const key = useSessionsStore((state) => ids.map((id) => {
    const slot = state.sessions[id];
    const awaiting = slot ? awaitingKindOfSlot(slot) : null;
    if (awaiting) return awaiting;
    return chatAgentActivity(slot, state.pendingLocalTurns[id]) === "running" ? "running" : "idle";
  }).join(","));
  return useMemo(() => (key ? (key.split(",") as AgentsSessionStatus[]) : []), [key]);
}

/** Which of these chats finished off screen, as one primitive. */
function useUnreadIds(ids: readonly string[]): ReadonlySet<string> {
  const key = useSyncExternalStore(
    subscribeChatUnread,
    () => ids.filter((id) => chatUnread(id)).join("\u0001"),
    () => "",
  );
  return useMemo(() => new Set(key ? key.split("\u0001") : []), [key]);
}

const NO_IDS: readonly string[] = [];
const NO_CLOUD_FOLDERS: readonly { id: string; path: string }[] = [];
const NO_PLACE: AgentsRowPlace = { separate: false, cloud: false, project: null };

function descendants(node: SessionNode): ChatThread[] {
  return node.children.flatMap((child) => [child.chat, ...descendants(child)]);
}

interface AgentsRowItem {
  key: string;
  kind: "session" | "native" | "terminal";
  name: string;
  agentId: string | null;
  /** The chat the row opens: a native subagent opens the session that started it. */
  openId: string;
  signal: AgentsRowSignal;
  group: AgentsGroupId;
  place: AgentsRowPlace;
  /** The child workspace's folder, for its cloud status. */
  placeFolder: string | null;
  pulls: readonly SidebarPullRequest[];
  updatedAt: number;
  viewing: boolean;
}

export function AgentsTab({ active, scope }: { tab: WorkbenchTab; active: boolean; scope?: string }) {
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const folder = scope ?? activeFolder ?? "";
  const chats = useChats();
  const focusedId = useActiveChatId();
  // A focused side chat leaves the tab on the chat column's own session.
  const viewingId = sessionViewChatId(chats, focusedId, folder);
  const dispatch = useWorkspaceDispatch();
  const { workspace: currentWorkspace } = useActiveWorkspace();
  // The live list is the sidebar's shared cache; archived workspaces are not
  // fetched here, so a hidden tab stays inert. An archived child workspace
  // still shows its placement, from its folder.
  const { workspaces: live } = useLiveWorkspaces();
  const acknowledged = useSetupFailureAcknowledgements();
  const tree = useMemo(() => buildSessionTree(chats, folder, { includeArchived: true }), [chats, folder]);
  const [picked, setPicked] = useState<string | null>(null);
  const viewingRoot = viewingId ? sessionRootId(tree, viewingId) : null;
  const parentId = (picked && tree.byId.has(picked) ? picked : null)
    ?? (viewingRoot && tree.roots.some((root) => root.chat.id === viewingRoot) ? viewingRoot : null)
    ?? tree.roots[0]?.chat.id
    ?? null;
  const parent = parentId ? tree.byId.get(parentId) : undefined;
  const children = useMemo(() => (parent ? descendants(parent) : []), [parent]);
  const terminals = useMemo(
    () => chats.filter((chat) => chat.kind === "terminal" && !chat.archived && chat.folder === folder),
    [chats, folder],
  );
  // Every parent's descendants, so a tab can mark a child that needs you.
  const rootIds = useMemo(
    () => tree.roots.map((root) => ({ id: root.chat.id, ids: sessionDescendantIds(root) })),
    [tree],
  );
  const allChildIds = useMemo(() => rootIds.flatMap((root) => root.ids), [rootIds]);
  // Hidden retained tabs stay inert: no status scans while inactive.
  const watchIds = active ? allChildIds : NO_IDS;
  const statuses = useSessionStatuses(watchIds);
  const unread = useUnreadIds(watchIds);
  const statusOf = useMemo(() => new Map(watchIds.map((id, index) => [id, statuses[index] ?? "idle"])), [watchIds, statuses]);
  const ownerIds = useMemo(() => (parentId ? [parentId, ...children.map((chat) => chat.id)] : NO_IDS), [parentId, children]);
  const natives = useNativeSubagents(active ? ownerIds : NO_IDS);
  // Every descendant's own workspace and place, for its row and for the
  // Needs you dot on its parent's tab.
  const places = useMemo(() => {
    const out = new Map<string, { place: AgentsRowPlace; own: Workspace | null }>();
    if (!active) return out;
    for (const id of allChildIds) {
      const chat = tree.byId.get(id)?.chat;
      if (!chat) continue;
      const child = findWorkspaceForFolder(chat.folder, live);
      const place = agentsRowPlace(chat, { folder, current: currentWorkspace ?? null, child, cloud: isCloudWorkspace(chat.folder) });
      out.set(id, { place, own: place.separate && child ? child : null });
    }
    return out;
  }, [active, allChildIds, tree, live, folder, currentWorkspace]);
  // A child in its own cloud workspace reads that machine's state by its
  // folder, as its row's label does, whether or not the live list has it yet.
  const childCloudFolders = useMemo(() => {
    const seen = new Set<string>();
    for (const [id, { place }] of places) {
      const chat = place.separate && place.cloud ? tree.byId.get(id)?.chat : undefined;
      if (chat) seen.add(chat.folder);
    }
    return seen.size ? [...seen].map((path) => ({ id: path, path })) : NO_CLOUD_FOLDERS;
  }, [places, tree]);
  const cloudErrors = useCloudErrorWorkspaceIds(childCloudFolders);
  const signalOf = useCallback((chat: ChatThread): AgentsRowSignal => {
    const { place, own } = places.get(chat.id) ?? { place: NO_PLACE, own: null };
    return {
      status: statusOf.get(chat.id) ?? "idle",
      unread: unread.has(chat.id),
      archived: !!chat.archived,
      setupFailed: !!own && setupFailureShown(own, acknowledged.has(own.id)),
      cloudError: agentsChildCloudError(place, chat.folder, cloudErrors),
    };
  }, [places, statusOf, unread, acknowledged, cloudErrors]);
  // Stored chats stay browsable while a cloud runtime sleeps.
  useWorkbenchStatusSource({ pending: false, primary: true, hasContent: chats.length > 0 });

  const rows = useMemo<AgentsRowItem[]>(() => {
    const out: AgentsRowItem[] = [];
    for (const chat of children) {
      const { place, own } = places.get(chat.id) ?? { place: NO_PLACE, own: null };
      const signal = signalOf(chat);
      out.push({
        key: chat.id,
        kind: "session",
        name: sessionName(chat),
        agentId: chat.agentId ?? null,
        openId: chat.id,
        signal,
        group: agentsGroupOf(signal),
        place,
        placeFolder: place.separate && place.cloud ? chat.folder : null,
        pulls: own ? workspacePullRequests(own) : [],
        updatedAt: chat.updatedAt,
        viewing: chat.id === viewingId,
      });
    }
    for (const agent of natives) out.push(nativeRow(agent));
    for (const chat of terminals) {
      const signal: AgentsRowSignal = { status: "idle", unread: false };
      out.push({
        key: chat.id, kind: "terminal", name: sessionName(chat), agentId: chat.agentId ?? null, openId: chat.id,
        signal, group: "idle", place: NO_PLACE, placeFolder: null,
        pulls: [], updatedAt: chat.updatedAt, viewing: chat.id === viewingId,
      });
    }
    return out;
  }, [children, natives, terminals, places, signalOf, viewingId]);

  const needsYouByRoot = useMemo(() => new Set(rootIds.filter((root) => root.ids.some((id) => {
    const chat = tree.byId.get(id)?.chat;
    return !!chat && agentsGroupOf(signalOf(chat)) === "needs-you";
  })).map((root) => root.id)), [rootIds, tree, signalOf]);

  const groups = useMemo(() => groupAgentsRows(rows), [rows]);
  const select = (id: string) => openSession(dispatch, id);

  if (tree.roots.length === 0 && terminals.length === 0) {
    return <div className="text-fg3 flex h-full items-center justify-center text-xs" data-agents-empty="">No sessions yet</div>;
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto px-2 pt-12 pb-2" data-agents-tab="">
      <Tabs value={parentId ?? ""} onValueChange={setPicked} className="mx-auto flex w-full max-w-130 min-w-0 flex-col gap-2">
        {tree.roots.length > 0 && (
          // The parent tabs float above the cards, in the cards' own column:
          // no bar and no border, the same gap as between two cards.
          <TabsList variant="chrome" aria-label="Parent sessions" className="bg-bg1 sticky top-0 z-2 h-auto w-full justify-start overflow-x-auto p-0">
            {tree.roots.map((root) => (
              <TabsTrigger key={root.chat.id} variant="chrome" value={root.chat.id} className="max-w-48" data-agents-parent={root.chat.id}>
                <span className="min-w-0 truncate">{sessionName(root.chat)}</span>
                {needsYouByRoot.has(root.chat.id) && (
                  <span className="bg-orange-text size-1.5 shrink-0 rounded-full" role="img" aria-label="A child needs you" />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value={parentId ?? ""} forceMount className="mt-0 flex flex-col gap-2">
          {parent && rows.length === 0 && (
            <p className="text-fg3 px-2 py-2 text-xs">No child sessions</p>
          )}
          {groups.map((group) => (
            <AgentsGroupCard key={group.id} id={group.id} label={group.label} rows={group.rows} onOpen={select} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function nativeRow(agent: NativeSubagent): AgentsRowItem {
  const signal: AgentsRowSignal = { status: agent.running ? "running" : "idle", unread: false };
  return {
    key: `native:${agent.id}`, kind: "native", name: agent.title, agentId: null, openId: agent.ownerChatId,
    signal, group: agentsGroupOf(signal), place: NO_PLACE, placeFolder: null,
    pulls: [], updatedAt: 0, viewing: false,
  };
}

/** A group card: the sidebar's group header, then its rows. Archived starts
 *  collapsed. */
function AgentsGroupCard({ id, label, rows, onOpen }: {
  id: AgentsGroupId;
  label: string;
  rows: readonly AgentsRowItem[];
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(id !== "archived");
  const listId = useId();
  return (
    <section
      aria-label={label}
      className="bg-bg2 flex flex-col gap-0.5 rounded-xl p-1 [--surface-hover:var(--bg2-hover)]"
      data-agents-group={id}
    >
      <SidebarGroupHeader
        level="group"
        label={label}
        count={rows.length}
        expanded={expanded}
        controls={listId}
        onToggle={() => setExpanded((value) => !value)}
        className="rounded-lg"
      />
      <div id={listId} hidden={!expanded} className="flex flex-col gap-0.5">
        {expanded && rows.map((row) => <AgentsRow key={row.key} row={row} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function AgentsRow({ row, onOpen }: { row: AgentsRowItem; onOpen: (id: string) => void }) {
  const cloudStatus = useCloudWorkspaceStatus(row.placeFolder);
  const status = agentsRowStatus({ ...row.signal, cloudStatus: row.place.separate ? cloudStatus : null });
  const dot = sidebarStatusDot(status);
  const working = row.signal.status === "running" && !row.signal.archived;
  const groups = prMarkGroups(row.pulls);
  const time = formatCompactAge(row.updatedAt);
  return (
    <div
      className="relative flex min-w-0 items-center"
      data-agents-row={row.kind === "session" ? row.key : undefined}
      data-native-subagent={row.kind === "native" ? row.key.slice("native:".length) : undefined}
      data-agents-terminal={row.kind === "terminal" ? row.key : undefined}
    >
      {/* A full-size button under pointer-transparent content, so the PR
          marks stay their own buttons without nesting. */}
      <Button
        type="button"
        variant="ghost"
        aria-label={`Open ${row.name}`}
        aria-current={row.viewing ? "true" : undefined}
        onClick={() => onOpen(row.openId)}
        className="hover:bg-bg2-hover aria-[current=true]:bg-selected-bg aria-[current=true]:hover:bg-selected-bg focus-visible:inset-ring focus-visible:inset-ring-accent absolute inset-0 size-full rounded-lg border-0 p-0 shadow-none focus-visible:outline-none"
      />
      <span className="pointer-events-none relative flex w-full min-w-0 items-center gap-2 px-2 py-1.5">
        <span className="flex h-4.5 w-4 shrink-0 items-center justify-center self-start" data-agents-lead="">
          {dot ? (
            <span className={cn("size-1.5 rounded-full", dot)} role="img" aria-label={status?.label} data-agents-lead-dot="" />
          ) : working ? (
            <AgentActivityIndicator activity="running" />
          ) : row.kind === "native" ? (
            <Bot className="text-fg2 size-3.5" strokeWidth={1.5} aria-label="Agent" role="img" />
          ) : row.kind === "terminal" ? (
            <Terminal className="text-fg2 size-3.5" strokeWidth={1.5} aria-label="Terminal agent" role="img" />
          ) : (
            <AgentIcon agentId={row.agentId ?? ""} iconUrl={null} size={14} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-fg1 truncate text-xs leading-4.5">{row.name}</span>
          <span className="text-fg3 flex h-4 min-w-0 items-center gap-1.5 text-3xxs leading-4" data-agents-row-meta="">
            {row.place.separate && (
              <span className="inline-flex size-3 shrink-0 items-center justify-center" data-agents-placement={row.place.cloud ? "cloud" : "local"}>
                <SidebarPlacementIcon cloud={row.place.cloud} cloudStatus={cloudStatus} />
              </span>
            )}
            {status ? (
              <span className={cn("shrink-0 whitespace-nowrap", STATUS_TONE_CLS[status.tone])} data-agents-status-word="">{status.label}</span>
            ) : time ? (
              <span className="shrink-0 tabular-nums">{time}</span>
            ) : null}
            {groups.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <SidebarPrMarks groups={groups} layout={groups.length > 2 ? "combined" : "separate"} />
              </>
            )}
            {row.place.project && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate" data-agents-project="">{row.place.project}</span>
              </>
            )}
          </span>
        </span>
        {row.viewing ? (
          <span className="text-fg3 shrink-0 px-2 text-3xxs leading-4">Viewing</span>
        ) : (
          <span aria-hidden="true" className="bg-selected-bg text-fg1 inline-flex h-6 shrink-0 items-center rounded-md px-2 text-3xxs leading-4">
            Open
          </span>
        )}
      </span>
    </div>
  );
}
