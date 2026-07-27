// ──────────────────────────────────────────────────────────
// ReviewChecksSection — the Review tab's Checks sub-tab
// ──────────────────────────────────────────────────────────
//
// CI checks + deploy statuses bucketed Failed → Running → Passed (failures
// first — they're why you're here). Failed rows carry "Add to chat": a
// fix-it brief (buildFixCheckPrompt) drops into the active chat's composer so
// the agent can chase the log and land the fix. Durations come from the
// check-run timing the engine now forwards. The section re-renders live off
// the store's fast checks lane, so runs complete in place.

import React, { useState } from "react";
import { ExternalLink, MessageSquarePlus, Wrench } from "lucide-react";

import type { PrChecksResult, PrCheck, PrDeployment } from "../../native/git";
import { Button, Tooltip } from "@/zeros/ui/primitives";
import { cn } from "@/zeros/ui/cn";
import { buildFixCheckPrompt } from "../pr/pr-action-prompts";
import { bucketChecks, formatDuration, summarizeChecks } from "./review-model";
import {
  Centered,
  CheckGlyph,
  ErrorCallout,
  GroupHeader,
  OutcomeGlyph,
} from "./review-bits";

function checkDuration(c: PrCheck, now = Date.now()): string {
  if (!c.startedAt) return "";
  const end = c.completedAt ?? now;
  return formatDuration(end - c.startedAt);
}

export function ReviewChecksSection({
  data,
  loading,
  error,
  prNumber,
  branch,
  onAddToChat,
  onRetry,
}: {
  data: PrChecksResult | null;
  loading: boolean;
  error: string | null;
  prNumber: number;
  branch: string;
  onAddToChat: (text: string) => void;
  onRetry: () => void;
}) {
  // Groups with failures open failed+running and tuck passed away; an
  // all-green run shows everything.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  if (loading && !data) return <div className="min-h-24" aria-busy="true" />;
  if (error && !data)
    return (
      <div className="p-3">
        <ErrorCallout text={error} onRetry={onRetry} />
      </div>
    );
  if (!data) return null;
  if (data.checks.length === 0 && data.deployments.length === 0)
    return (
      <Centered>
        No checks reported for this pull request. CI results appear here the
        moment the provider reports them.
      </Centered>
    );

  const buckets = bucketChecks(data.checks);
  const summary = summarizeChecks(data);
  const toggle = (id: string) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Passed is collapsed by default only while something else needs attention.
  const passedDefaultClosed =
    buckets.failed.length > 0 || buckets.pending.length > 0;
  const isOpen = (id: string, defaultClosed = false) =>
    defaultClosed ? closedGroups.has(id) : !closedGroups.has(id);

  const row = (c: PrCheck, i: number, failed = false) => (
    <div
      key={`${c.name}-${i}`}
      className="group hover:bg-bg1-hover flex h-8 items-center gap-2 px-3 transition-colors duration-120 ease-out"
    >
      <CheckGlyph check={c} />
      <span className="text-fg1 min-w-0 flex-1 truncate text-xs">{c.name}</span>
      {failed && (
        <button
          type="button"
          onClick={() =>
            onAddToChat(
              buildFixCheckPrompt({
                checkName: c.name,
                prNumber,
                branch,
                detailsUrl: c.detailsUrl,
              }),
            )
          }
          className="text-2xxs text-fg2 hover:bg-bg2-hover hover:text-fg1 flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 opacity-0 transition-colors duration-120 ease-out group-hover:opacity-100 focus-visible:opacity-100"
        >
          <MessageSquarePlus className="size-3" /> Add to chat
        </button>
      )}
      <span className="text-2xxs text-muted-fg shrink-0 tabular-nums">
        {checkDuration(c)}
      </span>
      {c.detailsUrl && (
        <Tooltip label="Open logs">
          <a
            href={c.detailsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors duration-120 ease-out"
          >
            <ExternalLink className="size-3" />
          </a>
        </Tooltip>
      )}
    </div>
  );

  return (
    <div className="flex flex-col pb-3">
      {/* Summary strip (only when real checks reported — deployments alone
          carry their own per-card status) */}
      {summary.tone !== "none" && (
        <div className="border-border1 flex h-9 items-center gap-2 border-b px-3">
          <OutcomeGlyph
            outcome={
              summary.tone === "failure"
                ? "failed"
                : summary.tone === "pending"
                  ? "pending"
                  : "passed"
            }
          />
          <span
            className={cn(
              "text-xs font-medium",
              summary.tone === "failure"
                ? "text-red-primary"
                : summary.tone === "pending"
                  ? "text-yellow-primary"
                  : "text-green-primary",
            )}
          >
            {summary.label}
          </span>
          {summary.fraction && (
            <span className="text-muted-fg text-xs tabular-nums">
              {summary.fraction} passed
            </span>
          )}
          <div className="flex-1" />
          {buckets.failed.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() =>
                onAddToChat(
                  buildFixCheckPrompt({
                    checkName: buckets.failed.map((c) => c.name).join("`, `"),
                    prNumber,
                    branch,
                    detailsUrl: buckets.failed[0]?.detailsUrl ?? null,
                  }),
                )
              }
            >
              <Wrench className="size-3.5" /> Fix in chat
            </Button>
          )}
        </div>
      )}

      {buckets.failed.length > 0 && (
        <section>
          <GroupHeader
            label="Failed"
            count={buckets.failed.length}
            tone="failure"
            open={isOpen("failed")}
            onToggle={() => toggle("failed")}
          />
          {isOpen("failed") && buckets.failed.map((c, i) => row(c, i, true))}
        </section>
      )}
      {buckets.pending.length > 0 && (
        <section>
          <GroupHeader
            label="Running"
            count={buckets.pending.length}
            tone="pending"
            open={isOpen("pending")}
            onToggle={() => toggle("pending")}
          />
          {isOpen("pending") && buckets.pending.map((c, i) => row(c, i))}
        </section>
      )}
      {buckets.passed.length > 0 && (
        <section>
          <GroupHeader
            label="Passed"
            count={buckets.passed.length}
            tone="success"
            open={isOpen("passed", passedDefaultClosed)}
            onToggle={() => toggle("passed")}
          />
          {isOpen("passed", passedDefaultClosed) &&
            buckets.passed.map((c, i) => row(c, i))}
        </section>
      )}

      {data.deployments.length > 0 && (
        <section className="mt-2 flex flex-col gap-2 px-3">
          <span className="text-fg1 text-xs font-medium">Deployments</span>
          {data.deployments.map((d, i) => (
            <DeploymentCard key={`${d.environment}-${i}`} deployment={d} />
          ))}
        </section>
      )}
    </div>
  );
}

function DeploymentCard({ deployment: d }: { deployment: PrDeployment }) {
  const outcome =
    d.state === "success"
      ? "passed"
      : d.state === "failure" || d.state === "error"
        ? "failed"
        : "pending";
  return (
    <div className="border-border2 bg-bg2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <OutcomeGlyph outcome={outcome} />
        <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
          {d.environment}
        </span>
      </div>
      {d.description && (
        <p className="text-fg2 m-0 mt-1.5 text-xs leading-relaxed">
          {d.description}
        </p>
      )}
      {d.url && (
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-fg2 hover:text-fg1 mt-1.5 inline-flex items-center gap-1 text-xs underline-offset-2 transition-colors duration-120 ease-out hover:underline"
        >
          {d.url.replace(/^https?:\/\//, "")}{" "}
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
