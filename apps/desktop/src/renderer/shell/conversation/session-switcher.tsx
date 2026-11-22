import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronRight, Cloud, Columns2, Ellipsis, GitBranchPlus, Laptop, MessageSquarePlus, PencilLine, Plus, Rows2, X } from "lucide-react";
import { leafIds } from "../../state/chat-panes";
import { useChatPanesStore } from "../../state/chat-panes-store";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { requestFocusedPaneSplit } from "./pane-split-requests";
import { AgentAwaitingIcon } from "../../features/agent/agent-awaiting-indicator";
import { AgentIcon } from "../../features/agent/agent-icon";
import { useAnyChatAgentActivity, useAnyChatAwaitingKind } from "../../features/agent/sessions-store";
import { useOptionalAgentSessions } from "../../features/agent/sessions-hooks";
import { useNativeSubagents } from "../../features/agent/native-subagents";
import { RunStream } from "../../shared/ui/loading";
import { Button } from "../../shared/ui/primitives";
import { Input } from "../../shared/ui/primitives/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { addChildSession, canAddChildSession } from "../../features/agent/add-child-session";
import { canOpenSideChat, openSideChat } from "../../features/agent/side-chat";
import { spawnNewChatTab } from "../../state/spawn-default-chat";
import { editChat } from "../../state/cloud-chat-edits";
import { openSession } from "../../state/open-session";
import type { ChatThread } from "../../state/store";
import { useWorkspaceDispatch, useWorkspaceStore } from "../../state/store";
import { buildSessionTree, sessionDescendantIds, sessionLineage, type SessionNode, type SessionTree } from "../../state/session-tree";
import { useActiveChatId, useChats } from "../../state/workspace-store";
import { useArchivedWorkspaces, useLiveWorkspaces } from "../../state/use-projects";
import type { Workspace } from "../../platform/git";
import { findWorkspaceForFolder } from "../../state/workspace-resolution";
import { workspaceLabel } from "../workspace-tabs";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useNativeRuntime } from "../../platform/runtime";
import { OpenInSubmenu } from "./conversation-header";
import type { WorkspacePlacement } from "./workspace-identity";

export function sessionName(chat: ChatThread): string {
  return chat.title.trim() || "New session";
}

const NO_OWNER_IDS: readonly string[] = [];

const ROW_INDENT_CLS = ["pl-2", "pl-6", "pl-8", "pl-10", "pl-12"] as const;

const CRUMB_CLS = "text-fg1 min-w-0 max-w-60 gap-1.5 aria-expanded:bg-bg2-highlight";

/** Working, or the question/permission it waits on, across these sessions. */
function SessionStatus({ ids }: { ids: readonly string[] }) {
  const activity = useAnyChatAgentActivity(ids);
  const awaiting = useAnyChatAwaitingKind(ids);
  if (awaiting) return <AgentAwaitingIcon kind={awaiting} className="size-3.5 shrink-0" strokeWidth={1.25} />;
  if (activity === "running") return <RunStream size={12} className="text-blue-primary shrink-0" />;
  return null;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

export function workspaceBadgeLabel(
  folder: string,
  live: readonly Workspace[],
  archived: readonly Workspace[],
): string {
  const workspace = findWorkspaceForFolder(folder, live) ?? findWorkspaceForFolder(folder, archived);
  return workspace ? workspaceLabel(workspace) : folderName(folder);
}

/** Names the workspace a child session lives in, as the sidebar does. Archived
 *  child workspaces leave the sidebar but their sessions stay listed. */
export function WorkspaceBadge({ folder }: { folder: string }) {
  const { workspaces } = useLiveWorkspaces();
  const { workspaces: archived } = useArchivedWorkspaces();
  return (
    <span className="text-fg3 border-border1 shrink-0 rounded-sm border px-1 text-xxs leading-4" data-session-workspace="">
      {workspaceBadgeLabel(folder, workspaces, archived)}
    </span>
  );
}

function SessionRow({ node, depth, folder, activeId, expanded, onToggle, onSelect }: {
  node: SessionNode;
  depth: number;
  folder: string;
  activeId: string | null;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: (id: string) => void;
}) {
  const ids = useMemo(() => [node.chat.id, ...sessionDescendantIds(node)], [node]);
  const ownIds = useMemo(() => (onToggle ? [node.chat.id] : NO_OWNER_IDS), [onToggle, node.chat.id]);
  const hasNative = useNativeSubagents(ownIds).length > 0;
  const hasChildren = node.children.length > 0 || hasNative;
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(node.chat.id)}
      onKeyDown={onToggle && hasChildren ? (event) => {
        if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
          event.preventDefault();
          onToggle();
        }
      } : undefined}
      aria-expanded={onToggle && hasChildren ? !!expanded : undefined}
      data-session-row={node.chat.id}
      aria-current={node.chat.id === activeId ? "true" : undefined}
      className={`aria-[current=true]:bg-bg2-highlight ${ROW_INDENT_CLS[Math.min(depth, ROW_INDENT_CLS.length - 1)]}`}
    >
      {onToggle ? (
        <span
          role="button"
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          className={`text-fg3 -ml-1 flex size-4 shrink-0 items-center justify-center ${hasChildren ? "" : "invisible"}`}
          // The item selects on a pointerup it did not see go down, so keep
          // both halves of the press on the arrow.
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggle(); }}
        >
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} strokeWidth={1.5} />
        </span>
      ) : null}
      <AgentIcon agentId={node.chat.agentId ?? ""} iconUrl={null} size={14} />
      <span className="min-w-0 flex-1 truncate">{sessionName(node.chat)}</span>
      {node.chat.folder !== folder && <WorkspaceBadge folder={node.chat.folder} />}
      <SessionStatus ids={ids} />
    </DropdownMenuItem>
  );
}

function SubtreeRows({ node, depth, ...rest }: {
  node: SessionNode;
  depth: number;
  folder: string;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <NativeSubagentRows ownerId={node.chat.id} depth={depth} onSelect={rest.onSelect} />
      {node.children.map((child) => (
        <Fragment key={child.chat.id}>
          <SessionRow node={child} depth={depth} {...rest} />
          <SubtreeRows node={child} depth={depth + 1} {...rest} />
        </Fragment>
      ))}
    </>
  );
}

/** Provider-native subagents are icon-only and read-only: choosing one opens
 *  the session whose turn started it. */
function NativeSubagentRows({ ownerId, depth, onSelect }: {
  ownerId: string;
  depth: number;
  onSelect: (id: string) => void;
}) {
  const ids = useMemo(() => [ownerId], [ownerId]);
  const agents = useNativeSubagents(ids);
  return (
    <>
      {agents.map((agent) => (
        <DropdownMenuItem
          key={agent.id}
          onSelect={() => onSelect(agent.ownerChatId)}
          data-native-subagent={agent.id}
          className={ROW_INDENT_CLS[Math.min(depth, ROW_INDENT_CLS.length - 1)]}
        >
          <Bot className="text-fg2 size-3.5 shrink-0" strokeWidth={1.5} aria-label="Agent" />
          <span className="min-w-0 flex-1 truncate">{agent.title}</span>
          {agent.running && <RunStream size={12} className="text-blue-primary shrink-0" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Every parent session, collapsed, with New parent session. */
export function ParentMenu({ tree, folder, activeId, onSelect, onNewParent }: {
  tree: SessionTree;
  folder: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewParent?: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return (
    <>
      {tree.roots.map((root) => (
        <Fragment key={root.chat.id}>
          <SessionRow
            node={root}
            depth={0}
            folder={folder}
            activeId={activeId}
            expanded={open.has(root.chat.id)}
            onToggle={() => toggle(root.chat.id)}
            onSelect={onSelect}
          />
          {open.has(root.chat.id) && (
            <SubtreeRows node={root} depth={1} folder={folder} activeId={activeId} onSelect={onSelect} />
          )}
        </Fragment>
      ))}
      {onNewParent && (
        <>
          {tree.roots.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={onNewParent} data-session-new-parent="">
            <Plus className="size-4" strokeWidth={1.5} />
            New parent session
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

export function RenameRow({ chat }: { chat: ChatThread }) {
  const dispatch = useWorkspaceDispatch();
  const [draft, setDraft] = useState(chat.title);
  useEffect(() => setDraft(chat.title), [chat.title]);
  const cancelled = useRef(false);
  const pending = useRef<{ draft: string; title: string } | null>(null);
  const save = (next: string, title: string) => {
    pending.current = null;
    const name = next.trim();
    if (name && name !== title) editChat(dispatch, chat.id, { title: name });
  };
  const commit = () => {
    if (cancelled.current) cancelled.current = false;
    else save(draft, chat.title);
    setDraft(chat.title);
  };
  pending.current = cancelled.current || draft === chat.title ? null : { draft, title: chat.title };
  useEffect(() => {
    // The menu's own Escape handler (document, capture) closes it before the
    // field sees the key, so mark the cancel earlier, on window.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.target instanceof Element && event.target.closest("[data-session-rename]"))
        cancelled.current = true;
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);
  // Dismissing the menu by clicking outside unmounts the field without a blur.
  const saveOnUnmount = useRef(save);
  saveOnUnmount.current = save;
  useEffect(() => () => {
    const last = pending.current;
    if (last && !cancelled.current) saveOnUnmount.current(last.draft, last.title);
  }, []);
  return (
    <>
      <label className="text-fg2 flex items-center gap-2 px-2 py-1.5">
        <PencilLine className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <Input
          appearance="inline"
          aria-label="Rename session"
          data-session-rename=""
          value={draft}
          placeholder={sessionName(chat)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // Keep typing out of the menu's typeahead and arrow navigation.
            if (event.key === "Escape") {
              cancelled.current = true;
              setDraft(chat.title);
              return;
            }
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          }}
          className="min-w-0 flex-1"
        />
      </label>
      <DropdownMenuSeparator />
    </>
  );
}

function Crumb({ chat, leading, identity, rename, children }: {
  chat: ChatThread;
  rename?: boolean;
  leading?: React.ReactNode;
  /** The first crumb is the workspace's identity: placement, then name. */
  identity?: WorkspacePlacement;
  children: React.ReactNode;
}) {
  const name = sessionName(chat);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={CRUMB_CLS}
          data-session-crumb={chat.id}
          {...(identity ? {
            "data-workspace-identity": "",
            "aria-label": `${name}, ${identity === "cloud" ? "Cloud" : "Local"} workspace`,
          } : {})}
        >
          {leading}
          <span className="min-w-0 truncate" {...(identity ? { "data-workspace-name": "" } : {})}>{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="max-h-96 min-w-64 max-w-96 overflow-y-auto">
        {rename && <RenameRow chat={chat} />}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header's Parent › Child › Grandchild path. The parent opens every
 * parent session; a child opens only its own line and descendants. */
export function SessionSwitcher({ folder, placement, showPlacement = true, fallback, readOnly = false }: {
  folder: string;
  placement: WorkspacePlacement;
  /** Cloud shows its placement on the workspace details beside it. */
  showPlacement?: boolean;
  /** Shown while the folder has no session yet. */
  fallback: React.ReactNode;
  readOnly?: boolean;
}) {
  const chats = useChats();
  const activeId = useActiveChatId();
  const dispatch = useWorkspaceDispatch();
  const sessions = useOptionalAgentSessions();
  const tree = useMemo(() => buildSessionTree(chats, folder, { includeArchived: true }), [chats, folder]);
  const lineage = useMemo(() => {
    const path = activeId ? sessionLineage(tree, activeId) : [];
    return path.length ? path : tree.roots[0] ? [tree.roots[0].chat] : [];
  }, [tree, activeId]);
  if (lineage.length === 0) return <>{fallback}</>;
  const select = (id: string) => readOnly ? dispatch({ type: "SET_ACTIVE_CHAT", id }) : openSession(dispatch, id);
  const newParent = readOnly || !sessions ? undefined : () => {
    void spawnNewChatTab({ folder, sessions, dispatch }).then((chat) => select(chat.id)).catch(() => {});
  };
  const Icon = placement === "cloud" ? Cloud : Laptop;
  return (
    <nav aria-label="Sessions" className={`${showPlacement ? "-ml-1.5" : ""} flex min-w-0 items-center`} data-session-switcher="">
      {lineage.map((chat, index) => {
        const node = tree.byId.get(chat.id);
        return (
          <Fragment key={chat.id}>
            {index > 0 && <ChevronRight className="text-fg3 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />}
            <Crumb
              chat={chat}
              rename={!readOnly && chat.id === activeId}
              identity={index === 0 && showPlacement ? placement : undefined}
              leading={index === 0 && showPlacement
                ? <Icon className="text-fg2 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" data-workspace-placement={placement} />
                : undefined}
            >
              {index === 0 ? (
                <ParentMenu tree={tree} folder={folder} activeId={activeId} onSelect={select} onNewParent={newParent} />
              ) : (
                <>
                  {lineage.slice(0, index).map((ancestor, depth) => {
                    const ancestorNode = tree.byId.get(ancestor.id);
                    return ancestorNode
                      ? <SessionRow key={ancestor.id} node={{ ...ancestorNode, children: [] }} depth={depth} folder={folder} activeId={activeId} onSelect={select} />
                      : null;
                  })}
                  {node && <SessionRow node={node} depth={index} folder={folder} activeId={activeId} onSelect={select} />}
                  {node && <SubtreeRows node={node} depth={index + 1} folder={folder} activeId={activeId} onSelect={select} />}
                </>
              )}
            </Crumb>
          </Fragment>
        );
      })}
    </nav>
  );
}

/** The ⋯ menu at the end of the session row. */
export function SessionActionsMenu({ folder, readOnly = false }: { folder: string; readOnly?: boolean }) {
  const split = useChatPanesStore((state) => {
    const layout = state.byFolder[folder];
    return layout ? leafIds(layout.root).length > 1 : false;
  });
  const dispatch = useWorkspaceDispatch();
  const parent = useWorkspaceStore((state) => {
    const active = state.chats.find((chat) => chat.id === state.activeChatId);
    return active?.folder === folder ? active : undefined;
  });
  // Same gate as the pane menu: host apps cannot open a cloud workspace.
  const showOpenIn = useNativeRuntime().ready && !isCloudWorkspace(folder);
  if (readOnly) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Session actions" data-session-actions="">
          <Ellipsis className="size-4" strokeWidth={1.5} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        {canAddChildSession(parent) && (
          <DropdownMenuItem
            data-session-add-child=""
            onSelect={() => addChildSession(parent, { publishChat: (chat) => dispatch({ type: "ADD_CHAT", chat }) })}
          >
            <GitBranchPlus className="size-4" strokeWidth={1.5} />
            Add child session
            <DropdownMenuShortcut>⌥⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {canOpenSideChat(parent) && (
          <DropdownMenuItem
            data-session-side-chat=""
            onSelect={() => openSideChat(parent, null, { publishChat: (chat) => dispatch({ type: "ADD_CHAT", chat }) })}
          >
            <MessageSquarePlus className="size-4" strokeWidth={1.5} />
            New side chat
          </DropdownMenuItem>
        )}
        {(canAddChildSession(parent) || canOpenSideChat(parent)) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => requestFocusedPaneSplit("right")}>
          <Columns2 className="size-4" strokeWidth={1.5} />
          Split right
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => requestFocusedPaneSplit("down")}>
          <Rows2 className="size-4" strokeWidth={1.5} />
          Split down
        </DropdownMenuItem>
        {split && (
          <DropdownMenuItem onSelect={() => requestFocusedPaneSplit("merge")} data-session-close-split="">
            <X className="size-4" strokeWidth={1.5} />
            Close split
          </DropdownMenuItem>
        )}
        {showOpenIn && (
          <>
            <DropdownMenuSeparator />
            <OpenInSubmenu path={folder} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A split pane's slim row: which session it shows. */
export function PaneSessionBar({ chat, focused }: { chat: ChatThread | null; focused: boolean }) {
  return (
    <div className="border-border1 flex h-8 shrink-0 items-center gap-1.5 border-b px-3" data-pane-session-bar="" data-chat-id={chat?.id} data-focused={focused ? "true" : "false"}>
      {chat && <AgentIcon agentId={chat.agentId ?? ""} iconUrl={null} size={14} />}
      <span className={`min-w-0 truncate text-xs ${focused ? "text-fg1" : "text-fg2"}`}>{chat ? sessionName(chat) : "New session"}</span>
    </div>
  );
}
