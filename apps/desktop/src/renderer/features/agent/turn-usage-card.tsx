import { useEffect, useId, useState } from "react";
import type { TurnUsageInfo } from "@/renderer/platform/turns";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/renderer/shared/ui/primitives/hover-card";
import { formatElapsed } from "@/renderer/shared/ui/loading";

function valid(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function turnUsageDisplay(
  agentId: string | null | undefined,
  usage: TurnUsageInfo | null | undefined,
) {
  const provider = agentId?.toLowerCase() ?? "";
  const name = provider.includes("claude")
    ? "Claude"
    : provider.includes("codex")
      ? "Codex"
      : provider.includes("cursor")
        ? "Cursor"
        : "Agent";
  const tokens = (value: unknown) =>
    valid(value) ? value.toLocaleString() : "Unavailable";
  // Old records used provider-specific cache conventions. Their dollar values
  // cannot be repaired without the discarded query/run baselines.
  const input =
    valid(usage?.inputTokens) &&
    usage.accountingVersion !== 1 &&
    name !== "Codex"
      ? usage.inputTokens +
        (valid(usage.cacheReadTokens) ? usage.cacheReadTokens : 0) +
        (valid(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0)
      : usage?.inputTokens;
  const hasCost =
    name !== "Codex" &&
    usage?.accountingVersion === 1 &&
    valid(usage.totalCostUsd);
  return {
    name,
    input: tokens(input),
    output: tokens(usage?.outputTokens),
    cacheRead: tokens(usage?.cacheReadTokens),
    cost: hasCost ? `$${usage.totalCostUsd!.toFixed(2)}` : "Unavailable",
    estimated: hasCost && (usage.costKind === "estimated" || name === "Claude"),
  };
}

export function TurnUsageCard({
  agentId,
  usage,
  startedAt,
  endedAt,
  durationMs,
  enabled = true,
}: {
  agentId?: string | null;
  usage?: TurnUsageInfo | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const details = turnUsageDisplay(agentId, usage);
  const validTime = (time: number) =>
    valid(time) && time <= 8_640_000_000_000_000;
  const date = (time: number) =>
    validTime(time)
      ? new Date(time).toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "Unavailable";
  return (
    <HoverCard
      enabled={enabled}
      open={enabled && open}
      onOpenChange={setOpen}
      openDelay={150}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="text-fg2 hover:text-fg1 focus-visible:ring-highlighted-bright rounded-sm tabular-nums outline-none focus-visible:ring-2"
          aria-label={`Turn usage, ${formatElapsed(durationMs)}`}
          aria-describedby={open && enabled ? id : undefined}
          onClick={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          {formatElapsed(durationMs)}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        id={id}
        role="tooltip"
        side="top"
        align="start"
        className="w-max max-w-[calc(100vw-2rem)] min-w-64 p-3 text-xs"
      >
        <div className="text-fg1 font-medium">{details.name}</div>
        <div className="text-fg2 mt-1.5 mb-2.5 flex flex-wrap items-center gap-x-1.5 tabular-nums">
          <time
            dateTime={
              validTime(startedAt)
                ? new Date(startedAt).toISOString()
                : undefined
            }
          >
            {date(startedAt)}
          </time>
          <span aria-hidden="true">→</span>
          <time
            dateTime={
              validTime(endedAt) ? new Date(endedAt).toISOString() : undefined
            }
          >
            {date(endedAt)}
          </time>
        </div>
        <dl className="border-border2 space-y-1.5 border-t pt-2.5">
          {[
            ["Input", details.input],
            ["Output", details.output],
            ["Cache read", details.cacheRead],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-8"
            >
              <dt className="text-fg2">{label}</dt>
              <dd className="text-fg1 tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="border-border2 mt-2.5 flex items-baseline justify-between gap-8 border-t pt-2.5">
            <dt className="text-fg2">
              Total cost{" "}
              {details.estimated && (
                <span className="text-fg2 text-2xxs">· Estimated</span>
              )}
            </dt>
            <dd className="text-fg1 tabular-nums">{details.cost}</dd>
          </div>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}
