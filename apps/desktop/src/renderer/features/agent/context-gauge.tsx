// ──────────────────────────────────────────────────────────
// ContextGauge — the context ring + breakdown popover
// ──────────────────────────────────────────────────────────
//
// One small ring beside Send, in every chat. It quietly fills as the
// conversation grows and has EXACTLY TWO visual states: calm `fg2` chrome its
// whole life, `red-primary` at ≥90% — the
// "about to hit the wall" signal. No yellow, no green, no spinner; the
// compaction progress lives in the transcript row (CompactionRecordCard),
// not here. The arc animates on change so a post-compaction drop is
// visible motion.
//
// Click → the Context popover (standard bg3 recipe): title + fraction,
// one monochrome bar, "Free space" first, then per-category rows where
// the agent supplies them (Claude via getContextUsage; Codex Used/Free
// only), and a footer with the Compact-now action for agents that have a
// real compaction trigger.
//
// Cursor: its SDK reports no token usage and has no compaction call — the
// ring renders DISABLED (empty track) and the popover says so plainly rather
// than showing a made-up number.
//
// The ring is ALWAYS present: before the first
// message it renders the empty track with "Send a message to see context
// usage." as tooltip + popover body — it never pops in and out of the
// toolbar. The no-data popovers (pre-first-message and Cursor) show ONLY
// the message, no "Context" title and no footer.
// ──────────────────────────────────────────────────────────

import { memo, useMemo } from "react";

import { cn } from "@/renderer/shared/ui/cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import type { AgentUsage } from "./use-agent-session";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 37.70

/** 48200 → "48.2k", 1_000_000 → "1.0M", 900 → "900". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(n)));
}

function Ring({
  fraction,
  disabled,
}: {
  fraction: number;
  disabled?: boolean;
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const critical = clamped >= 0.9;
  return (
    <svg
      className="size-4 -rotate-90"
      viewBox="0 0 16 16"
      role="img"
      aria-label={
        disabled
          ? "Context usage unavailable"
          : `Context ${Math.round(clamped * 100)}% used`
      }
    >
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-border3"
      />
      {!disabled && (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${clamped * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          className={cn(
            "transition-[stroke-dasharray] duration-300 ease-out",
            critical ? "stroke-red-primary" : "stroke-fg2",
          )}
        />
      )}
    </svg>
  );
}

export interface ContextGaugeProps {
  /** Session token accounting (sessions-store). `size`/`used` come from
   *  usage_update; `categories` from Claude's getContextUsage. */
  usage: Pick<AgentUsage, "size" | "used" | "categories"> | null | undefined;
  /** Set for agents whose protocol reports no usage (Cursor): renders the
   *  disabled ring; the tooltip + popover show ONLY this text (no title,
   *  no numbers). Unset with no usage data yet → the "Send a message to
   *  see context usage." pre-first-message state instead. */
  unavailableReason?: string;
  /** Run a real compaction (Codex thread/compact/start; Claude /compact).
   *  Absent → no footer action (agent has no compaction trigger). */
  onCompactNow?: () => void;
  /** Disable the Compact-now action (e.g. while a turn is streaming — the
   *  gate mirrors the composer's own canSend). */
  compactDisabled?: boolean;
}

/** True when the gauge has real numbers to show. */
function hasData(
  usage: ContextGaugeProps["usage"],
): usage is {
  size: number;
  used: number;
  categories?: AgentUsage["categories"];
} {
  return (
    !!usage &&
    typeof usage.size === "number" &&
    usage.size > 0 &&
    typeof usage.used === "number" &&
    usage.used >= 0
  );
}

export const ContextGauge = memo(function ContextGauge({
  usage,
  unavailableReason,
  onCompactNow,
  compactDisabled,
}: ContextGaugeProps) {
  const data = hasData(usage) ? usage : null;

  const rows = useMemo(() => {
    if (!data) return [];
    const free = Math.max(0, data.size - data.used);
    const pct = (n: number) => `${((n / data.size) * 100).toFixed(1)}%`;
    const categories = (data.categories ?? [])
      .filter((c) => c.tokens > 0)
      // "Free space" is OUR computed lead row — drop any same-named
      // category an agent reports (Claude's getContextUsage includes one)
      // so it can never render twice.
      .filter((c) => !/^free space$/i.test(c.name.trim()))
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .map((c) => ({ name: c.name, pct: pct(c.tokens), lead: false }));
    return [
      { name: "Free space", pct: pct(free), lead: true },
      // Agents without a per-category breakdown (Codex reports only window
      // fill; its protocol has no category accounting) still get an honest
      // second row: everything in the window that isn't free.
      ...(categories.length > 0
        ? categories
        : [{ name: "Used", pct: pct(data.used), lead: false }]),
    ];
  }, [data]);

  // No usage yet: an agent that will never report it (Cursor) shows its own
  // reason; one that just hasn't produced data yet (no message sent, or a
  // freshly swapped session) invites the first send. Either way the ring
  // stays put — it must never pop in and out of the toolbar.
  const noDataMessage =
    unavailableReason ?? "Send a message to see context usage.";

  const fraction = data ? data.used / data.size : 0;
  const tooltip = data
    ? `Context · ${Math.round(Math.min(1, fraction) * 100)}% used`
    : noDataMessage;

  return (
    <Popover>
      <Tooltip label={tooltip}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={tooltip}
            className={cn(
              "hover:bg-bg2-hover text-fg2 hover:text-fg1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent p-0 transition-colors",
              !data && "text-muted-fg",
            )}
          >
            <Ring fraction={fraction} disabled={!data} />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" side="top" className="p-3.5">
        {/* No-data popovers (pre-first-message / Cursor) carry ONLY the
        message — no "Context" title, no bar, no footer. */}
        {data ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-fg1 text-sm font-semibold">Context</span>
              <span className="text-fg2 font-mono text-xs">
                {formatTokens(data.used)} / {formatTokens(data.size)}
              </span>
            </div>
            <div className="bg-bg4 mt-2.5 h-1.5 overflow-hidden rounded-full">
              <div
                className="bg-fg1 h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${Math.min(100, fraction * 100)}%` }}
              />
            </div>
            <div className="mt-2 flex flex-col">
              {rows.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between px-0.5 py-1 text-[12.5px]"
                >
                  <span className="text-fg2">{r.name}</span>
                  <span
                    className={cn(
                      "font-mono text-xs tabular-nums",
                      r.lead ? "text-fg1" : "text-fg2",
                    )}
                  >
                    {r.pct}
                  </span>
                </div>
              ))}
            </div>
            {onCompactNow && (
              <div className="border-border2 mt-2 border-t pt-2">
                <button
                  type="button"
                  disabled={compactDisabled}
                  onClick={onCompactNow}
                  className="hover:bg-bg3-hover text-fg2 hover:text-fg1 w-full cursor-pointer rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50"
                >
                  Compact now
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="text-fg2 text-[12.5px]">{noDataMessage}</p>
        )}
      </PopoverContent>
    </Popover>
  );
});
