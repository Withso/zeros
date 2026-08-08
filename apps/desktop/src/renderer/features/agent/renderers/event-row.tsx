// ──────────────────────────────────────────────────────────
// EventRow — one inline row per non-text event
// ──────────────────────────────────────────────────────────
//
// Per-tool card variants collapse into ONE inline row. Borderless,
// with no card chrome. The row is a 20px
// content line (text-sm's line-height) with `py-1` → 4px top +
// 4px bottom padding INSIDE the hover target (so the tint wraps
// the breathing room); spacing between rows is that padding, not
// an outer-wrapper gap.
//
//   [icon] Read package.json                       200 lines  read  ✓
//
// On hover, the leading icon swaps to + (collapsed) or −
// (open) — the expand affordance. Click toggles the
// detail body inline below the row at pl-7.
//
// The detail body is rendered by `renderDetail(message)` —
// per-kind extension point that delegates to the existing
// preview components (shiki edit diff, xterm shell output,
// search-by-file groupings, etc.) without their old card
// wrappers.
// ──────────────────────────────────────────────────────────

import { memo, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { metaForEvent, statusTone, type EventMeta } from "./event-meta";
import { FileTag } from "./file-tag";
import type { RendererContext } from "./types";
import { DiffHoverCard } from "./diff-hover-preview";

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
  fail: "text-red-primary/90",
  run: "",
  pending: "opacity-60",
};

const TONE_ICON_COLOR: Record<ReturnType<typeof statusTone>, string> = {
  ok: "text-fg2",
  fail: "text-red-primary/80",
  run: "text-fg1",
  pending: "text-muted-fg",
};

export const EventRow = memo(function EventRow({
  message,
  ctx: _ctx,
  meta: metaOverride,
  detail,
  trailingNode,
  hoverPreview,
  defaultOpen,
  toneOverride,
}: EventRowProps) {
  const meta = metaOverride ?? metaForEvent(message);
  const [open, setOpen] = useState(defaultOpen ?? false);
  const isTool = message.kind === "tool";
  const status = isTool ? (message as AgentToolMessage).status : undefined;
  const sTone =
    toneOverride ?? (isTool ? statusTone(status as any) : undefined);
  // 01g: ALL tool rows are expandable because renderDetail always supplies a
  // useful fallback. Non-tool rows only expand when their meta says there is
  // detail and the renderer actually supplied it; this prevents blank expanded
  // panels for short warning/error/mode rows.
  const hasDetail = detail !== undefined && detail !== null;
  const expandable = isTool ? hasDetail : meta.expandable && hasDetail;
  const Icon = meta.Icon;
  const iconTone = sTone ? TONE_ICON_COLOR[sTone] : "text-fg2";
  const rowTint = sTone ? TONE_ROW_TINT[sTone] : "";

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
        if (expandable) setOpen((v) => !v);
      }}
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
          <Icon className={meta.iconClassName} />
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

      {/* Label — the tool NAME, at full `fg1` (the focal item the user
          scans for) and the larger tier: `text-sm` (14px), with content at
          12px. It can be long (e.g. a Claude
          Bash description), so it is capped at `60ch` + truncated: a long
          label ellipsizes there instead of shoving the command off the row.
          The cap is in `ch` (not `%`) because the row is now content-width —
          a `%` cap would resolve against the row's own shrunk width and could
          clip even a short label. A short label ("Read"/"Bash") stays its
          natural width and the command follows. */}
      <span className="text-fg1 max-w-[60ch] shrink-0 truncate text-sm">
        {meta.label}
      </span>

      {/* Target — a file/image TAG (FileTypeIcon + bg1/border3 pill) for file
          tools (Read/Edit/List), else a plain command/query/thought pill. The
          tag carries the same glyph as the Files tab so a Read of `foo.tsx`
          and an Edit of it match. min-w-0 + truncate ellipsize a long name. */}
      {meta.target &&
        (meta.targetFile ? (
          <FileTag name={meta.target} kind={meta.targetKind} />
        ) : (
          <span className="bg-bg1-hover text-fg2 max-w-[440px] min-w-0 truncate rounded-sm px-1.5 py-0.5 text-xs">
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
    </button>
  );

  return (
    <div className="flex flex-col">
      {hoverPreview ? (
        <DiffHoverCard trigger={row}>{hoverPreview}</DiffHoverCard>
      ) : (
        row
      )}
      {expandable && open && (
        // Expanded detail is LEFT-ALIGNED with the row content — no pl-7 indent
        // under the label and no permanent left inset — so a thinking/bash/grep
        // body fills the lane width. The detail's own box
        // (pre/diff) supplies its bg.
        <div className="pt-1.5 pr-2 pb-2">
          {/* 01t (2026-05-20) — failed-tool output gets a very subtle
              red tint so the user can recognise an error at a glance
              without the icon being the only signal. Zeros Foundation anti-pattern
              says no solid red fills — bg-red-primary/5 + a faint ring
              hit the right tone. The Failed icon (already destructive)
              still leads. */}
          <div
            className={cn(
              // Tool output renders at fg1 and shiki-highlighted contextually
              // (event-row-renderer's HighlightedCode: Read by file language,
              // Bash/Grep/Glob as shell) — so it reads like code. Plain or
              // unhighlightable output inherits fg1.
              "text-fg1 text-sm",
              sTone === "fail" &&
                "bg-red-primary/5 ring-red-primary/15 rounded-md px-2.5 py-1.5 ring-1",
            )}
          >
            {detail}
          </div>
        </div>
      )}
    </div>
  );
});

// Re-export so callers can type meta overrides.
export type { EventMeta };
