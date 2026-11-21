import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Cloud, Columns2, Ellipsis, Laptop, Plus, Rows2, X } from "lucide-react";
import { leafIds } from "../../state/chat-panes";
import { useChatPanesStore } from "../../state/chat-panes-store";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { requestFocusedPaneSplit } from "./pane-split-requests";
import { AgentAwaitingIcon } from "../../features/agent/agent-awaiting-indicator";
import { AgentIcon } from "../../features/agent/agent-icon";
import { useAnyChatAgentActivity, useAnyChatAwaitingKind } from "../../features/agent/sessions-store";
import { useOptionalAgentSessions } from "../../features/agent/sessions-hooks";
import { RunStream } from "../../shared/ui/loading";
import { Button } from "../../shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { spawnNewChatTab } from "../../state/spawn-default-chat";
import type { ChatThread } from "../../state/store";
import { useWorkspaceDispatch } from "../../state/store";
import { buildSessionTree, sessionDescendantIds, sessionLineage, type SessionNode, type SessionTree } from "../../state/session-tree";
import { useActiveChatId, useChats } from "../../state/workspace-store";
import type { WorkspacePlacement } from "./workspace-identity";

export function sessionName(chat: ChatThread): string {
  return chat.title.trim() || "New session";
}

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
  const hasChildren = node.children.length > 0;
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(node.chat.id)}
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
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggle(); }}
        >
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} strokeWidth={1.5} />
        </span>
      ) : null}
      <AgentIcon agentId={node.chat.agentId ?? ""} iconUrl={null} size={14} />
      <span className="min-w-0 flex-1 truncate">{sessionName(node.chat)}</span>
      {node.chat.folder !== folder && (
        <span className="text-fg3 border-border1 shrink-0 rounded-sm border px-1 text-xxs leading-4" data-session-workspace="">
          {folderName(node.chat.folder)}
        </span>
      )}
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
      {node.children.map((child) => (
        <Fragment key={child.chat.id}>
          <SessionRow node={child} depth={depth} {...rest} />
          <SubtreeRows node={child} depth={depth + 1} {...rest} />
        </Fragment>
      ))}
    </>
  );
}

/** Every parent session, collapsed, with New parent session. */
function ParentMenu({ tree, folder, activeId, onSelect, onNewParent }: {
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

function Crumb({ chat, leading, children }: { chat: ChatThread; leading?: React.ReactNode; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={CRUMB_CLS} data-session-crumb={chat.id}>
          {leading}
          <span className="min-w-0 truncate">{sessionName(chat)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="max-h-96 min-w-64 max-w-96 overflow-y-auto">
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
  const tree = useMemo(() => buildSessionTree(chats, folder, { includeArchived: readOnly }), [chats, folder, readOnly]);
  const lineage = useMemo(() => {
    const path = activeId ? sessionLineage(tree, activeId) : [];
    return path.length ? path : tree.roots[0] ? [tree.roots[0].chat] : [];
  }, [tree, activeId]);
  if (lineage.length === 0) return <>{fallback}</>;
  const select = (id: string) => dispatch({ type: "SET_ACTIVE_CHAT", id });
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
  if (readOnly) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Session actions" data-session-actions="">
          <Ellipsis className="size-4" strokeWidth={1.5} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
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
