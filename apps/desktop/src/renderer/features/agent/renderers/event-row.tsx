// Shared transcript disclosure: a compact tool name and target, followed by
// one bounded detail surface while expanded. Native/durable identity belongs
// to the adapter and caller; output or status changes never own expansion.
// File identities stay visible when open; command/query previews do not.

import { memo, useId, useState } from "react";
import { CircleX, Minus, Plus } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import {
  hasTransportTruncation,
  metaForEvent,
  statusTone,
  type EventMeta,
} from "./event-meta";
import { ToolDetailSurface } from "./tool-detail-surface";
import { FileTag } from "./file-tag";
import type { RendererContext } from "./types";
import { DiffHoverCard } from "./diff-hover-preview";
import { ToolIdentityIcon } from "./tool-identity-icon";
import { nativeToolSurface, toolRecord } from "./native-tool-presentation";

interface EventRowProps {
  message: AgentMessage;
  ctx: RendererContext;
  /** Optional override of the auto-derived meta. Used by subagent
   *  renderer to inject custom label/target. */
  meta?: EventMeta;
  /** Optional detail body. When provided + `meta.expandable`, the row
   *  is clickable to toggle the detail open/closed. */
  detail?: React.ReactNode;
  /** Optional trailing content rendered after the target — overrides
   *  `meta.trailing`. Used by EditCard for the green/red +N −M counts. */
  trailingNode?: React.ReactNode;
  /** Optional exact diff shown on hover/focus. Only EditCard supplies this;
   *  generic/Read tool rows deliberately remain ordinary expandable rows. */
  hoverPreview?: React.ReactNode;
  /** Seed the detail body open at MOUNT (the exit-plan card starts open so
   *  the plan is readable without a click). Mount-time only — it feeds
   *  useState's initializer, so after first render `open` belongs to the
   *  user and later prop changes neither open nor close the row. Do NOT
   *  derive it from mutable message state (e.g. tool status): whether such a
   *  row starts open would depend on whether the status landed before or
   *  after the row's first commit, and every remount (summary-chip
   *  re-expand, chat reopen) would re-apply it over the user's collapse. */
  defaultOpen?: boolean;
  /** Batched native actions share one disclosure without remounting their rows. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Override the status-derived row tone. The question record uses "ok":
   *  its tool status is "failed" because Claude's answer is DELIVERED via a
   *  deny tool_result — a transport detail, not a failure; the red tint +
   *  destructive body ring would lie to the user. */
  toneOverride?: ReturnType<typeof statusTone>;
}

// Status is conveyed by row tint, not a right-side text badge; the row tone is
// the only status signal.
const TONE_ROW_TINT: Record<ReturnType<typeof statusTone>, string> = {
  ok: "",
  fail: "text-red-primary",
  run: "",
  pending: "",
};

// Collapsed-row chrome (icon, target pill) sits at `--fg3`, 12px, weight 500;
// the tool NAME stays `fg1` / 14px. Only the failed tone overrides to red.
const TONE_ICON_COLOR: Record<ReturnType<typeof statusTone>, string> = {
  ok: "text-fg3",
  fail: "text-red-primary [&_*]:text-red-primary!",
  run: "text-fg3",
  pending: "text-fg3",
};

/** Vertical rhythm of a working feed: 8px between every entry, at every
 *  depth (top-level stripe, nested agent bodies, multi-row commands). */
export const WORKING_FEED_GAP = "gap-y-2";

export const EventRow = memo(function EventRow({
  message,
  ctx,
  meta: metaOverride,
  detail,
  trailingNode,
  hoverPreview,
  defaultOpen,
  toneOverride,
  open: controlledOpen,
  onOpenChange,
}: EventRowProps) {
  const meta = metaOverride ?? metaForEvent(message);
  const [localOpen, setLocalOpen] = useState(defaultOpen ?? false);
  const open = controlledOpen ?? localOpen;
  const detailId = useId();
  const isThinking = message.kind === "text" && message.role === "thought";
  const isTool = message.kind === "tool";
  const transportTruncated =
    isTool && hasTransportTruncation(message as AgentToolMessage);
  const status = isTool ? (message as AgentToolMessage).status : undefined;
  const sTone =
    toneOverride ?? (isTool ? statusTone(status as any) : undefined);
  const expandable = meta.expandable && detail !== undefined && detail !== null;
  const Icon = sTone === "fail" ? CircleX : meta.Icon;
  const surface = isTool
    ? nativeToolSurface(message as AgentToolMessage)
    : null;
  const artwork = isTool
    ? toolRecord((message as AgentToolMessage).rawInput)._zerosToolArtwork
    : undefined;
  const iconTone = sTone ? TONE_ICON_COLOR[sTone] : "text-fg3";
  const rowTint = sTone ? TONE_ROW_TINT[sTone] : "";

  const accessibleTarget = meta.targetFile ? meta.target?.replace(/\/+$/, "").split("/").pop() : meta.target;
  const row = (
    <button
      type="button"
      // Width hugs the content (`w-fit`) and never exceeds the lane
      // (`max-w-full`): the hover tint then wraps exactly the row's content
      // instead of painting the empty space out to the right edge.
      className={cn(
        "group/event-row -ml-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        expandable ? "hover:bg-bg2-hover/40 cursor-pointer" : "cursor-default",
        rowTint,
      )}
      onClick={() => {
        if (expandable) {
          setLocalOpen(!open);
          onOpenChange?.(!open);
        }
      }}
      aria-label={[meta.label, accessibleTarget, meta.trailing].filter(Boolean).join(" ")}
      aria-description={status === "failed" ? "Tool failed" : undefined}
      aria-controls={expandable && open ? detailId : undefined}
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable}
    >
      {/* Leading icon with hover swap to +/- when expandable. The cell IS
          the icon — 12px (size-3) with NO larger wrapper box around it. The
          size-3 inline-flex just stacks Icon / Plus / Minus in one
          spot so only the active one shows. `[&_svg]:size-3` sizes every
          descendant icon to 12×12. */}
      <span
        className={cn(
          "relative inline-flex size-3 shrink-0 items-center justify-center [&_svg]:size-3",
          iconTone,
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "inline-flex",
            expandable && "group-hover/event-row:hidden",
          )}
        >
          <ToolIdentityIcon
            artwork={sTone === "fail" ? undefined : artwork}
            appId={
              sTone !== "fail" && surface?.kind === "computer"
                ? surface.appId
                : undefined
            }
            fallback={Icon}
            active={ctx.attachmentImagesActive !== false}
            className={cn("size-3", meta.iconClassName)}
          />
        </span>
        {expandable && (
          <>
            <Plus
              className={cn(
                "hidden size-3",
                open ? "" : "group-hover/event-row:inline",
              )}
            />
            <Minus
              className={cn(
                "hidden size-3",
                open ? "group-hover/event-row:inline" : "",
              )}
            />
          </>
        )}
      </span>

      {/* Stable operation name; a long native/MCP name must still fit the lane. */}
      <span
        className={cn(
          "max-w-[60ch] min-w-0 truncate text-sm",
          sTone === "fail" ? "text-red-primary" : "text-fg1",
        )}
      >
        {sTone === "fail" ? "Error" : meta.label}
      </span>

      {/* Target — a file/image TAG (FileTypeIcon + bg1/border3 pill) for file
          tools (Read/Edit/List), else a plain command/query/thought pill. The
          tag carries the same glyph as the Files tab so a Read of `foo.tsx`
          and an Edit of it match. min-w-0 + truncate ellipsize a long name. */}
      {meta.target && (meta.targetFile || !open) &&
        (meta.targetFile ? (
          <FileTag name={meta.target} kind={meta.targetKind} className={sTone === "fail" ? "border-red-primary/25 bg-red-bg text-red-primary hover:bg-red-bg [&_*]:text-red-primary!" : undefined} />
        ) : (
          <span data-tool-preview="" className={cn("max-w-[440px] min-w-0 truncate rounded-sm px-1.5 py-0.5 text-xs font-medium", sTone === "fail" ? "bg-red-bg text-red-primary" : "bg-bg1-hover text-fg3")}>
            {meta.target}
          </span>
        ))}
      {/* Trailing — a custom node (EditCard's green/red +N −M) wins; else the
          string meta.trailing (Grep match count, etc.). Read's line count
          lives in the LABEL now, so reads carry no trailing. */}
      {trailingNode ??
        (meta.trailing ? (
          <span className="text-fg2 shrink-0 text-xs tabular-nums">
            {meta.trailing}
          </span>
        ) : null)}
      {transportTruncated && (
        <span
          className="bg-yellow-bg text-yellow-fg shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium"
          title="The provider truncated this tool payload"
        >
          Truncated
        </span>
      )}
    </button>
  );

  return (
    <div className="flex flex-col">
      {hoverPreview ? (
        <DiffHoverCard trigger={row} enabled={!open && ctx.attachmentImagesActive !== false}>{hoverPreview}</DiffHoverCard>
      ) : (
        row
      )}
      {expandable && open && (
        <div id={detailId} className={cn("min-w-0 pr-2", isThinking ? "py-1" : "pt-1.5 pb-2")}>
          {isThinking ? (
            detail
          ) : (
            <ToolDetailSurface
              label={`${meta.label} details`}
              failed={sTone === "fail"}
            >
              {detail}
            </ToolDetailSurface>
          )}
        </div>
      )}
    </div>
  );
});

// Re-export so callers can type meta overrides.
export type { EventMeta };
