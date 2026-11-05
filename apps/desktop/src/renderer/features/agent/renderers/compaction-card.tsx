// ──────────────────────────────────────────────────────────
// CompactionRecordCard — the compaction tool-call row
// ──────────────────────────────────────────────────────────
//
// Context compaction renders like any other thing the agent does — a line
// in the working stripe with exactly two states:
//
//   • running  — the Orbit shimmer (ZerosSpinner) + "Compacting.."
//   • settled  — lucide `CircleCheckBig` + "Context compacted" + a no-icon
//                "Done" StatusChip (same recipe as the question record's
//                ANSWERED chip: border1, mono 10px uppercase, over bg1)
//
// No banners, no colored pills, no third state — a failed compaction just
// settles the row and the normal error surfaces handle the rest. Codex
// streams both states from the `contextCompaction` item lifecycle; Claude's
// `compact_boundary` arrives at the boundary, so its row appears directly
// settled. Rendered ON TOP OF EventRow (same 12px icon cell + detail
// container as every tool row).
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import { CircleCheckBig, CircleSlash } from "lucide-react";

import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { Badge } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { DETAIL_BODY_CLS } from "./tool-detail-surface";

import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { EventRow, type EventMeta } from "./event-row";
import { renderDetail } from "./event-row-renderer";

/** Leading indicator for the live compaction row — the Orbit shimmer at
 *  the row-icon size (12px), slotted through EventMeta's Icon. Compaction
 *  is infrastructure loading, not the agent producing output, so it takes
 *  the default orbit variant (not the agent wave). */
function CompactingIcon({ className }: { className?: string }) {
  return <ZerosSpinner size={12} label="Compacting" className={className} />;
}

/** The record's status: the shared outline Badge, as the question record's. */
function DoneChip() {
  return <Badge variant="outline">Done</Badge>;
}

/** Optional detail: adapters may stamp rawInput with {trigger, preTokens}
 *  (Claude's compact_boundary carries both). Absent → generic tool details. */
function readDetail(
  input: unknown,
): { trigger?: string; preTokens?: number } | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as { trigger?: unknown; preTokens?: unknown };
  const trigger = typeof o.trigger === "string" ? o.trigger : undefined;
  const preTokens = typeof o.preTokens === "number" ? o.preTokens : undefined;
  return trigger || preTokens !== undefined ? { trigger, preTokens } : null;
}

/** A failed compaction's reason, stamped by the Claude translator from the
 *  CLI's compact_error ("Not enough messages to compact."). */
function readError(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const err = (output as { error?: unknown }).error;
  return typeof err === "string" && err.trim().length > 0 ? err : null;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export const CompactionRecordCard: Renderer<AgentToolMessage> = memo(
  function CompactionRecordCard({ message, ctx }) {
    const running =
      message.status === "pending" || message.status === "in_progress";
    // A failed compaction (Claude compact_result:"failed" — e.g. "Not
    // enough messages to compact.") settles honestly: "Compaction failed",
    // no Done chip, the CLI's reason in the expandable detail. Still
    // neutral-toned — the failure costs nothing and the reason says why.
    const failed = !running && message.status === "failed";
    const info = readDetail(message.rawInput);
    const error = failed ? readError(message.rawOutput) : null;
    const fallback = !!message.rawOutput && typeof message.rawOutput === "object" &&
      (message.rawOutput as { fallback?: unknown }).fallback === true;

    const meta: EventMeta = running
      ? {
          Icon: CompactingIcon,
          label: "Compacting..",
          expandable: false,
        }
      : failed
        ? {
            Icon: CircleSlash,
            label: "Compaction failed",
            expandable: error !== null,
          }
        : {
            Icon: CircleCheckBig,
            label: "Context compacted",
            expandable: info !== null,
          };

    const detail = running ? undefined : failed ? (
      error ? (
        <div className={DETAIL_BODY_CLS}>{error}</div>
      ) : undefined
    ) : info || fallback ? (
      <div className={cn(DETAIL_BODY_CLS, "gap-0.5")}>
        {info?.trigger ? (
          <div>
            <span className="text-fg2/70">Trigger: </span>
            {info.trigger}
          </div>
        ) : null}
        {info?.preTokens !== undefined ? (
          <div>
            <span className="text-fg2/70">Context before: </span>
            {fmtTokens(info.preTokens)} tokens
          </div>
        ) : null}
        {fallback ? <div>Cursor saved a trimmed transcript because it could not generate a summary.</div> : null}
      </div>
    ) : undefined;

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={{ ...meta, expandable: true }}
        detail={detail ?? renderDetail(message, ctx)}
        trailingNode={running || failed ? null : <DoneChip />}
        // Never tint red: a failed compaction costs nothing — the row label
        // + detail carry the reason.
        toneOverride="ok"
      />
    );
  },
);
