// Shared transcript disclosure: a compact tool name and target, followed by
// one bounded detail surface while expanded. Native/durable identity belongs
// to the adapter and caller; output or status changes never own expansion.
// File identities stay visible when open; command/query previews do not.

import { memo, useId, useMemo } from "react";
import { CircleX, Minus, Plus, Terminal } from "lucide-react";

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
import { pendingChecksMessage } from "./tool-pending-checks";
import { useTurnDisclosure } from "../turn-disclosures";
import { Badge, LIST_ROW_IN_GROUP, ListRow, ListRowGroup, Tooltip } from "@/renderer/shared/ui/primitives";
import { ImageHoverCard, imagePreviewMimeType } from "../image-hover-card";
import { filePillPath, openFilePill, warmFilePill } from "@/renderer/shell/workbench/file-pill-navigation";
import { useLocalLinks } from "../local-links/context";
import { LocalLinkPill } from "../local-links/pill";
import { localLinkSpans } from "../local-links/model";
import { localCliPresentation, type LocalCliTarget } from "./local-cli-presentation";

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
  /** Exact recorded diff shown on the file pill, independently of disclosure. */
  hoverPreview?: React.ReactNode;
  /** Seed an unseen disclosure (the exit-plan card starts open so the plan
   * is readable without a click). Later prop changes do not override the
   * user's choice, which survives regrouping within the mounted turn. Do not
   * derive the default from mutable tool status: opening a fresh transcript
   * must not depend on when a result happened to arrive. */
  defaultOpen?: boolean;
  /** Native facets of one tool (for example, files in a batch edit) own
   * independent disclosures under the same durable message. */
  disclosureKey?: string;
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
  disclosureKey = "details",
  toneOverride,
  open: controlledOpen,
  onOpenChange,
}: EventRowProps) {
  const links = useLocalLinks();
  const localCli = useMemo(() => links.enabled && message.kind === "tool" ? localCliPresentation(message, links.scheme) : null, [message, links.enabled, links.scheme]);
  const meta = useMemo(() => {
    const original = metaOverride ?? metaForEvent(message);
    return localCli ? { ...original, Icon: Terminal, label: localCli.label, target: localCli.preview, targetFile: false } : original;
  }, [metaOverride, message, localCli]);
  const [localOpen, setLocalOpen] = useTurnDisclosure<boolean>(message.id, disclosureKey, defaultOpen ?? false);
  const open = controlledOpen ?? localOpen;
  const detailId = useId();
  const isThinking = message.kind === "text" && message.role === "thought";
  const isTool = message.kind === "tool";
  const transportTruncated =
    isTool && hasTransportTruncation(message as AgentToolMessage);
  const status = isTool ? (message as AgentToolMessage).status : undefined;
  const pendingChecks = isTool ? pendingChecksMessage(message) : null;
  const sTone =
    toneOverride ?? (pendingChecks ? "ok" : meta.tone ?? (isTool ? statusTone(status as any) : undefined));
  const expandable = meta.expandable && detail !== undefined && detail !== null;
  const Icon = sTone === "fail" ? CircleX : meta.Icon;
  const SecondIcon = sTone === "fail" ? undefined : meta.SecondIcon;
  const surface = isTool
    ? nativeToolSurface(message as AgentToolMessage)
    : null;
  const artwork = isTool
    ? toolRecord((message as AgentToolMessage).rawInput)._zerosToolArtwork
    : undefined;
  const iconTone = sTone ? TONE_ICON_COLOR[sTone] : "text-fg3";
  const rowTint = sTone ? TONE_ROW_TINT[sTone] : "";

  const accessibleTarget = meta.targetFile ? meta.target?.replace(/\/+$/, "").split("/").pop() : meta.target;
  const fileRow = !!(meta.target && meta.targetFile);
  const localTargets = useMemo<LocalCliTarget[]>(() => {
    if (!links.enabled) return [];
    if (localCli) return localCli.targets;
    const hrefs = [meta.label, fileRow ? "" : meta.target ?? ""]
      .flatMap((text) => localLinkSpans(text, links.scheme).map((span) => span.href));
    return [...new Set(hrefs)].map((href) => ({ href }));
  }, [links.enabled, links.scheme, localCli, meta, fileRow]);
  const separateTargets = fileRow || !!localCli || localTargets.length > 0;
  const active = ctx.attachmentImagesActive !== false;
  const destination = isTool && message.toolKind === "edit" ? "changes" : "file";
  const path = meta.filePath;
  const canOpen = active && !!path && !!filePillPath(ctx.attachmentCwd, path);
  const warmFile = () => {
    if (canOpen && path) warmFilePill(ctx.attachmentCwd, path, destination);
  };
  let filePill: React.ReactNode = fileRow ? (
    <FileTag
      name={path ?? meta.target!}
      kind={meta.targetKind}
      data-file-path={path}
      aria-label={`Open ${accessibleTarget}`}
      aria-disabled={!canOpen || undefined}
      onPointerEnter={warmFile}
      onFocus={warmFile}
      onClick={() => { if (canOpen && path) openFilePill(ctx.attachmentCwd, path, destination); }}
      className={cn(sTone === "fail" && "border-red-primary/25 bg-red-bg text-red-primary hover:bg-red-bg [&_*]:text-red-primary!")}
    />
  ) : null;
  if (filePill && hoverPreview) {
    filePill = <DiffHoverCard trigger={filePill as React.ReactElement} enabled={!open && active}>{hoverPreview}</DiffHoverCard>;
  } else if (filePill && path && destination === "file" && imagePreviewMimeType(path)) {
    filePill = <ImageHoverCard name={path} path={path} cwd={ctx.attachmentCwd} enabled={active && !open}>{filePill as React.ReactElement}</ImageHoverCard>;
  } else if (filePill) {
    // The tag shows the base name; the shared hint carries the hidden path.
    filePill = <Tooltip label={path ?? meta.target ?? ""}>{filePill as React.ReactElement}</Tooltip>;
  }
  const trailing = <>
    {trailingNode ?? (meta.trailing ? <span className="text-fg2 shrink-0 text-xs tabular-nums">{meta.trailing}</span> : null)}
    {transportTruncated && <Tooltip label="The provider truncated this tool payload"><Badge variant="warning" className="shrink-0">Truncated</Badge></Tooltip>}
  </>;
  const preview = meta.target && !open ? (
    <span data-tool-preview="" className={cn(
      // A 20px chip: 13/16 on bg2, the height and size of the file tags beside it.
      "max-w-[440px] min-w-0 truncate rounded-sm px-1.5 py-0.5 text-xs leading-4 font-medium",
      localCli && sTone !== "fail" && "font-mono",
      sTone === "fail" ? "bg-red-bg text-red-primary" : "bg-bg2 text-fg2",
    )}>{meta.target}</span>
  ) : null;
  const toggle = () => {
    if (!expandable) return;
    if (controlledOpen === undefined) setLocalOpen(!open);
    onOpenChange?.(!open);
  };
  const disclosure = (
    <ListRow
      data-list-row-disclosure=""
      // Width hugs the content (`w-fit`) and never exceeds the lane
      // (`max-w-full`): the hover tint then wraps exactly the row's content
      // instead of painting the empty space out to the right edge.
      className={cn(
        // A 28px row with 6px corners and the bg1-hover fill.
        "-ml-2 flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        !separateTargets && "group/event-row",
        expandable ? "hover:bg-bg1-hover cursor-pointer" : "cursor-default",
        // Beside its targets the button is only the icon and name; the
        // ListRowGroup around them draws the row.
        separateTargets && LIST_ROW_IN_GROUP,
        rowTint,
      )}
      onClick={toggle}
      aria-label={[meta.label, accessibleTarget, meta.trailing].filter(Boolean).join(" ")}
      aria-description={pendingChecks ?? (sTone === "fail" ? "Tool failed" : undefined)}
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
          // Two glyphs side by side (a local command): 12 + 4 + 12px.
          SecondIcon && "w-7 justify-start",
          iconTone,
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "inline-flex",
            SecondIcon && "gap-1",
            expandable && "group-hover/event-row:hidden",
          )}
        >
          <ToolIdentityIcon
            artwork={sTone === "fail" || localCli ? undefined : artwork}
            appId={
              sTone !== "fail" && surface?.kind === "computer"
                ? surface.appId
                : undefined
            }
            fallback={Icon}
            active={ctx.attachmentImagesActive !== false}
            className={cn("size-3", meta.iconClassName)}
          />
          {SecondIcon && <SecondIcon className={cn("size-3", meta.iconClassName)} />}
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
          "max-w-[60ch] min-w-0 truncate text-reading leading-5",
          sTone === "fail" ? "text-red-primary" : "text-fg1",
        )}
      >
        {sTone === "fail" ? "Error" : meta.label}
      </span>

      {!separateTargets && preview}
      {!separateTargets && trailing}
    </ListRow>
  );

  return (
    <div className="flex flex-col">
      {separateTargets ? <ListRowGroup
        interactive={expandable}
        onToggle={toggle}
        className={cn("group/event-row", !fileRow && "flex-wrap", rowTint)}
      >
        {disclosure}
        {filePill}
        {localTargets.map((target) => <LocalLinkPill key={target.href} href={target.href} fallback={target.fallback} />)}
        {!fileRow && preview}
        {trailing}
      </ListRowGroup> : disclosure}
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
