// ──────────────────────────────────────────────────────────
// ReviewChecksSection — the Review tab's Checks sub-tab
// ──────────────────────────────────────────────────────────
//
// A summary card counts the run (failed, running, expected, passed) over one
// bar and offers Re-run failed and Add failures to chat. CI checks follow in
// Failed → Expected → Running → Passed groups (failures first — they're why
// you're here); a check the base branch requires carries Required, and a
// required check that hasn't reported waits in Expected. A failed row's Add to
// chat drops a fix-it brief (buildFixCheckPrompt) into the active composer.
// Durations come from the check-run timing the engine forwards, and the
// section re-renders live off the store's fast checks lane, so runs complete
// in place. Deployments close the tab as cards with their state and Open.

import React, { useState } from "react";
import { ArrowUpRight, CircleDashed, Globe, RotateCw } from "lucide-react";

import type {
  PrChecksResult,
  PrCheck,
  PrDeployment,
} from "../../../platform/git";
import { Badge, Button, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { buildFixCheckPrompt } from "../../pr/pr-action-prompts";
import { bucketChecks, formatDuration } from "./review-model";
import {
  CheckGlyph,
  ErrorCallout,
  GroupHeader,
  OutcomeGlyph,
} from "./review-shared-components";
import { REVIEW_CARD, ReviewSection } from "./review-overview";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";

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
  onRerunFailed,
}: {
  data: PrChecksResult | null;
  loading: boolean;
  error: string | null;
  prNumber: number;
  branch: string;
  onAddToChat: (text: string) => void;
  onRetry: () => void;
  /** Present when the provider can start failed runs again. Reports its own
   *  failure and resolves once the write settles. */
  onRerunFailed?: () => Promise<void>;
}) {
  // Groups with failures open failed+running and tuck passed away; an
  // all-green run shows everything.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  if (loading && !data) return <div className="min-h-24" aria-busy="true" />;
  if (error && !data) return <ErrorCallout text={error} onRetry={onRetry} />;
  if (!data) return null;
  const expected = data.expected ?? [];
  if (data.checks.length === 0 && data.deployments.length === 0 && expected.length === 0)
    return (
      <p className="text-fg3 m-0 text-xs">
        No checks reported yet. Results appear here as the provider reports
        them.
      </p>
    );

  const buckets = bucketChecks(data.checks);
  const toggle = (id: string) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Passed is collapsed by default only while something else needs attention;
  // a required check that hasn't reported still blocks the merge.
  const passedDefaultClosed =
    buckets.failed.length > 0 || buckets.pending.length > 0 || expected.length > 0;
  const isOpen = (id: string, defaultClosed = false) =>
    defaultClosed ? closedGroups.has(id) : !closedGroups.has(id);
  const fixPrompt = (checks: PrCheck[]) =>
    buildFixCheckPrompt({
      checkName: checks.map((c) => c.name).join("`, `"),
      prNumber,
      branch,
      detailsUrl: checks[0]?.detailsUrl ?? null,
    });

  const row = (c: PrCheck, i: number, failed = false) => (
    <div
      key={`${c.name}-${i}`}
      data-review-check={c.name}
      className="group hover:bg-bg1-hover flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2.5 transition-colors duration-120 ease-out"
    >
      <CheckGlyph check={c} />
      <span className="text-fg1 min-w-0 truncate text-xs">{c.name}</span>
      {c.required ? <Badge variant="neutral">Required</Badge> : null}
      <span className="flex-1" />
      {failed && (
        <Button
          variant="ghost"
          size="compact"
          className="text-fg2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onAddToChat(fixPrompt([c]))}
        >
          Add to chat
        </Button>
      )}
      <span className="text-fg3 text-3xxs shrink-0 leading-4 tabular-nums">
        {checkDuration(c)}
      </span>
      {c.detailsUrl && (
        <Tooltip label="Open logs">
          <IconButton asChild size="compact" label="Open logs" className="text-fg3 shrink-0">
            <a href={c.detailsUrl} target="_blank" rel="noreferrer">
              <ArrowUpRight aria-hidden />
            </a>
          </IconButton>
        </Tooltip>
      )}
    </div>
  );

  const rerun =
    onRerunFailed && buckets.failed.some((c) => c.rerunnable) ? onRerunFailed : undefined;
  return (
    <>
      {(data.checks.length > 0 || expected.length > 0) && (
        <ChecksSummaryCard
          failed={buckets.failed.length}
          running={buckets.pending.length}
          expected={expected.length}
          passed={buckets.passed.length}
          onAddFailures={() => onAddToChat(fixPrompt(buckets.failed))}
          onRerunFailed={rerun}
        />
      )}
      {(data.checks.length > 0 || expected.length > 0) && (
        <div className="-mx-2.5 flex min-w-0 flex-col gap-1">
          {buckets.failed.length > 0 && (
            <section aria-label="Failed checks">
              <GroupHeader
                label="Failed"
                count={buckets.failed.length}
                open={isOpen("failed")}
                onToggle={() => toggle("failed")}
              />
              {isOpen("failed") && buckets.failed.map((c, i) => row(c, i, true))}
            </section>
          )}
          {expected.length > 0 && (
            <section aria-label="Expected checks">
              <GroupHeader
                label="Expected"
                count={expected.length}
                open={isOpen("expected")}
                onToggle={() => toggle("expected")}
              />
              {isOpen("expected") &&
                expected.map((check) => (
                  <div
                    key={check.name}
                    data-review-check-expected={check.name}
                    className="flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2.5"
                  >
                    <CircleDashed aria-hidden className="text-fg3 size-3.5 shrink-0" />
                    <span className="text-fg1 min-w-0 truncate text-xs">{check.name}</span>
                    <Badge variant="neutral">Required</Badge>
                    <span className="flex-1" />
                    <span className="text-fg3 text-3xxs shrink-0 leading-4">Not reported yet</span>
                  </div>
                ))}
            </section>
          )}
          {buckets.pending.length > 0 && (
            <section aria-label="Running checks">
              <GroupHeader
                label="Running"
                count={buckets.pending.length}
                open={isOpen("pending")}
                onToggle={() => toggle("pending")}
              />
              {isOpen("pending") && buckets.pending.map((c, i) => row(c, i))}
            </section>
          )}
          {buckets.passed.length > 0 && (
            <section aria-label="Passed checks">
              <GroupHeader
                label="Passed"
                count={buckets.passed.length}
                open={isOpen("passed", passedDefaultClosed)}
                onToggle={() => toggle("passed")}
              />
              {isOpen("passed", passedDefaultClosed) &&
                buckets.passed.map((c, i) => row(c, i))}
            </section>
          )}
        </div>
      )}
      {data.deployments.length > 0 && (
        <ReviewSection title="Deployments" count={data.deployments.length}>
          <div className="flex min-w-0 flex-col gap-2">
            {data.deployments.map((d, i) => (
              <DeploymentCard key={`${d.environment}-${i}`} deployment={d} />
            ))}
          </div>
        </ReviewSection>
      )}
    </>
  );
}

const SUMMARY_PARTS = [
  { key: "failed", label: "failed", outcome: "failed", bar: "bg-red-primary" },
  { key: "running", label: "running", outcome: "pending", bar: "bg-yellow-primary" },
  { key: "expected", label: "expected", outcome: "expected", bar: "bg-border3" },
  { key: "passed", label: "passed", outcome: "passed", bar: "bg-green-primary" },
] as const;

/** Counts per state over a bar whose segments share its width by count. */
function ChecksSummaryCard({
  failed,
  running,
  expected,
  passed,
  onAddFailures,
  onRerunFailed,
}: {
  failed: number;
  running: number;
  expected: number;
  passed: number;
  onAddFailures: () => void;
  onRerunFailed?: () => Promise<void>;
}) {
  const [rerunning, setRerunning] = useState(false);
  const counts = { failed, running, expected, passed };
  const parts = SUMMARY_PARTS.filter((part) => counts[part.key] > 0);
  return (
    <div
      data-review-checks-summary=""
      className={cn(REVIEW_CARD, "flex flex-col gap-3 py-3 pr-2.5 pl-3.5")}
    >
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {parts.map((part) => (
          <span
            key={part.key}
            data-review-checks-count={part.key}
            className="flex shrink-0 items-center gap-1.5 text-xs"
          >
            {part.outcome === "expected" ? (
              <CircleDashed aria-hidden className="text-fg3 size-3.5 shrink-0" />
            ) : (
              <OutcomeGlyph outcome={part.outcome} />
            )}
            <span className="text-fg1 font-medium tabular-nums">
              {counts[part.key]}
            </span>
            <span className="text-fg2">{part.label}</span>
          </span>
        ))}
        <span className="flex-1" />
        {failed > 0 && onRerunFailed && (
          <Button
            variant="secondary"
            size="compact"
            loading={rerunning}
            onClick={() => {
              setRerunning(true);
              void onRerunFailed().finally(() => setRerunning(false));
            }}
          >
            <RotateCw aria-hidden />
            Re-run failed
          </Button>
        )}
        {failed > 0 && (
          <Button variant="secondary" size="compact" onClick={onAddFailures}>
            Add failures to chat
          </Button>
        )}
      </div>
      <div aria-hidden className="mr-1 flex h-1 gap-0.5">
        {parts.map((part) => (
          <span
            key={part.key}
            className={cn("h-full rounded-full", part.bar)}
            style={{ flexGrow: counts[part.key] }}
          />
        ))}
      </div>
    </div>
  );
}

const DEPLOYMENT_STATE: Record<
  string,
  { label: string; variant: "success" | "failure" | "neutral" }
> = {
  success: { label: "Ready", variant: "success" },
  failure: { label: "Failed", variant: "failure" },
  error: { label: "Failed", variant: "failure" },
};

function DeploymentCard({ deployment: d }: { deployment: PrDeployment }) {
  const state = DEPLOYMENT_STATE[d.state] ?? {
    label: "Deploying",
    variant: "neutral" as const,
  };
  return (
    <div
      data-review-deployment={d.environment}
      className={cn(REVIEW_CARD, "flex min-h-13 items-center gap-3 py-2.5 pr-2.5 pl-3.5")}
    >
      <Globe aria-hidden className="text-fg3 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-fg1 min-w-0 truncate text-xs font-medium">
            {d.environment}
          </span>
          <Badge variant={state.variant}>{state.label}</Badge>
        </span>
        {d.url ? (
          <span className="text-fg3 text-3xxs truncate font-mono leading-4">
            {d.url.replace(/^https?:\/\//, "")}
          </span>
        ) : d.description ? (
          <span className="text-fg3 text-3xxs truncate leading-4">
            {d.description}
          </span>
        ) : null}
      </div>
      {d.url && (
        <Button asChild variant="ghost" size="compact" className="text-fg2 shrink-0">
          <a href={d.url} target="_blank" rel="noreferrer">
            <ArrowUpRight aria-hidden />
            Open
          </a>
        </Button>
      )}
    </div>
  );
}
