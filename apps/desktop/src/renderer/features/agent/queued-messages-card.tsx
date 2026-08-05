// ──────────────────────────────────────────────────────────
// QueuedMessagesCard — pending sends, docked above the composer
// ──────────────────────────────────────────────────────────
//
// Messages typed while a turn is in flight queue up here (they no longer
// render as greyed bubbles in the transcript — the queue redesign lifted
// them out of the reading flow). The card tucks under the composer's top edge:
//
//   ┌───────────────────────────────────────────┐
//   │ 2 queued messages                       ⌄ │   header (click = collapse)
//   │ ┌───────────────────────────────────────┐ │
//   │ │ helloo                        ✎  🗑  ↑ │ │   hover/selected row actions
//   │ └───────────────────────────────────────┘ │
//   │   hi there                                │
//   │ ────────────────────────────────────────  │
//   │ [↑↓] navigate                             │   footer shortcut hints
//   └───────────────╔═══════════════════════════╧═══╗
//                   ║  composer…                    ║
//
// Actions per row: Edit (loads the message into the composer — see
// agent-chat's "Editing queued message" mode), Delete, and Send now. Send
// now STEERS the running turn for agents that support it (Claude, Codex);
// for agents that don't (Cursor) the arrow is disabled with an explanatory
// tooltip. While the chat is idle (queue parked behind an edit), Send now
// is a plain out-of-order flush and is always allowed.
//
// Keyboard: ↑ from the composer's first line walks up into the list; ↑/↓
// move the selection; ↵ edits; ⌘↵ sends now; ⌫ deletes; Esc returns to the
// composer. The composer keeps DOM focus the whole time — the selection is
// virtual, so typing any character drops back into the draft.
// ──────────────────────────────────────────────────────────

import { memo, type ReactNode } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Paperclip,
  Pencil,
  Trash2,
} from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { Tooltip, TooltipProvider } from "@/renderer/shared/ui/primitives";
import type { AgentTextMessage } from "./use-agent-session";

export interface QueuedMessagesCardProps {
  /** Still-pending queued sends, FIFO (oldest first — send order). */
  messages: AgentTextMessage[];
  /** Row highlighted by ↑/↓ navigation (also set by hover-independent
   *  clicks). null = composer has the virtual focus. */
  selectedId: string | null;
  /** Row currently loaded into the composer for editing. */
  editingId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (id: string | null) => void;
  onEdit: (id: string) => void;
  /** Save the in-progress composer edit (tick icon on the editing row). */
  onSaveEdit: () => void;
  /** True while the composer edit is empty — the tick can't save nothing. */
  saveDisabled: boolean;
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
  /** Whether the agent can steer a RUNNING turn (agentCapabilities.steering). */
  steeringSupported: boolean;
  /** True while a turn is in flight — gates send-now on steering support.
   *  While idle, send-now is a plain flush and is always allowed. */
  streaming: boolean;
  /** For the disabled-send tooltip ("Cursor doesn't support steering"). */
  agentName: string;
}

export const QueuedMessagesCard = memo(function QueuedMessagesCard({
  messages,
  selectedId,
  editingId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onEdit,
  onSaveEdit,
  saveDisabled,
  onDelete,
  onSendNow,
  steeringSupported,
  streaming,
  agentName,
}: QueuedMessagesCardProps) {
  if (messages.length === 0) return null;
  const editing = editingId != null;
  const sendBlocked = streaming && !steeringSupported;
  const sendLabel = sendBlocked
    ? `${agentName} doesn't support mid-turn steering`
    : "Send now";

  return (
    // -mb-2.5 tucks the card's bottom edge under the composer card that
    // follows it in the dock (both are positioned, so DOM order paints the
    // composer on top) — the "attached" look. pb-1.5 keeps the footer clear
    // of the hidden strip.
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
      <div className="border-border1 bg-bg1 relative -mb-2.5 flex flex-col rounded-lg border pb-1.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className="text-fg2 hover:text-fg1 flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-sm transition-colors"
        >
          <span>
            {messages.length} queued message{messages.length === 1 ? "" : "s"}
          </span>
          {collapsed ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </button>
        {!collapsed && (
          <>
            <div className="border-border1 flex flex-col gap-0.5 border-t px-1.5 py-1.5">
              {messages.map((m) => {
                const isEditing = m.id === editingId;
                const isSelected = m.id === selectedId || isEditing;
                return (
                  <div
                    key={m.id}
                    data-queued-id={m.id}
                    onClick={() => onSelect(m.id)}
                    className={cn(
                      "group/qrow flex cursor-default items-center gap-2 rounded-md px-2.5 py-2",
                      isEditing
                        ? "border-border2 bg-bg2 border"
                        : isSelected
                          ? "bg-bg2-hover"
                          : "hover:bg-bg2-hover",
                    )}
                  >
                    <Tooltip label={m.text}>
                      <span className="text-fg1 min-w-0 flex-1 truncate text-sm">
                        {m.text}
                      </span>
                    </Tooltip>
                    {m.attachments && m.attachments.length > 0 && (
                      <Tooltip
                        label={`${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}`}
                      >
                        <span className="text-fg2 flex shrink-0 items-center gap-0.5 text-xs tabular-nums">
                          <Paperclip size={12} aria-hidden="true" />
                          {m.attachments.length}
                        </span>
                      </Tooltip>
                    )}
                    <div
                      className={cn(
                        "flex shrink-0 items-center gap-0.5",
                        isSelected
                          ? "opacity-100"
                          : "opacity-0 group-hover/qrow:opacity-100",
                      )}
                      // Row-click selects; the buttons act on their own row —
                      // don't let the bubble re-select mid-action.
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isEditing ? (
                        <RowAction
                          label="Save"
                          onClick={onSaveEdit}
                          disabled={saveDisabled}
                        >
                          <Check size={14} aria-hidden="true" />
                        </RowAction>
                      ) : (
                        <RowAction
                          label="Edit"
                          onClick={() => onEdit(m.id)}
                          disabled={editing || m.queuedEditable === false}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </RowAction>
                      )}
                      <RowAction
                        label="Delete"
                        destructive
                        onClick={() => onDelete(m.id)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </RowAction>
                      <RowAction
                        label={sendLabel}
                        onClick={() => onSendNow(m.id)}
                        disabled={sendBlocked}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </RowAction>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-border1 text-fg2 flex items-center gap-3 border-t px-3.5 py-2 text-xs">
              {editing ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <Keycap>↵</Keycap> save
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Keycap>Esc</Keycap> cancel
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1.5">
                    <Keycap>↑↓</Keycap> navigate
                  </span>
                  {selectedId != null && (
                    <>
                      <span className="flex items-center gap-1.5">
                        <Keycap>↵</Keycap> edit
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Keycap>⌫</Keycap> delete
                      </span>
                      {!sendBlocked && (
                        <span className="flex items-center gap-1.5">
                          <Keycap>⌘↵</Keycap> send now
                        </span>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
});

/** 24px icon button with a Radix tooltip. Disabled buttons keep pointer
 *  events (a disabled control with no explanation is a dead end — the
 *  tooltip carries the "why", e.g. "Cursor doesn't support steering"). */
function RowAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          "flex size-6 items-center justify-center rounded-sm transition-colors",
          disabled
            ? "text-fg3 cursor-default"
            : destructive
              ? "text-fg2 hover:bg-bg1-hover hover:text-red-primary"
              : "text-fg2 hover:bg-bg1-hover hover:text-fg1",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-border2 bg-bg2 text-fg2 text-xxs rounded-sm border px-1 py-0.5 font-sans leading-none">
      {children}
    </kbd>
  );
}
